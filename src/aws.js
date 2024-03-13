const AWS = require('aws-sdk');
const core = require('@actions/core');
const config = require('./config');
const { SpotParams } = require('./spot-params');

const successfulPercentThreshold = 65;
const ec2CreateBatchSize = 50;
const maxNumberInstances = 500;

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  } else {
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.313.0/actions-runner-linux-${RUNNER_ARCH}-2.313.0.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.313.0.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  }
}

async function startEc2Instances(githubRegistrationToken) {
  const maxTotalFailures = 25;
  let totalFailures = 0;
  let attemptNo = 1;
  const maxSuccessiveFailures = 5;

  let labelInstanceIdPairs = [];
  const errors = [];
  let successiveFailures = 0;

  const division = { spot: 0, reserved: 0 };

  const ec2 = new AWS.EC2();
  const totalRunners = Math.min(config.input.count, maxNumberInstances);
  core.info(`Starting ${totalRunners} ec2 instances`);

  let instancesToCreate = totalRunners > ec2CreateBatchSize ? ec2CreateBatchSize : totalRunners;

  let percentComplete = (labelInstanceIdPairs.length / totalRunners) * 100;
  let currentStrategy = config.input.strategy;
  while (percentComplete < successfulPercentThreshold && totalFailures < maxTotalFailures) {
    core.info(
      `Starting attempt ${
        successiveFailures + 1
      } of ${maxSuccessiveFailures} to start instances for label ${config.input.label}`
    );

    const userData = buildUserDataScript(githubRegistrationToken, config.input.label);

    let params = {
      ImageId: config.input.ec2ImageId,
      InstanceType: config.input.ec2InstanceType,
      MinCount: 1,
      MaxCount: instancesToCreate,
      UserData: Buffer.from(userData.join('\n')).toString('base64'),
      SubnetId: config.input.subnetId,
      SecurityGroupIds: [config.input.securityGroupId],
      IamInstanceProfile: { Name: config.input.iamRoleName },
      TagSpecifications: config.tagSpecifications,
    };

    // if spot instance
    if (currentStrategy) {
      core.info(`Starting instance with ${currentStrategy} strategy`);
      const spotParams = new SpotParams(ec2);
      params = await spotParams.modifyInstanceConfiguration(params, currentStrategy);
    }

    try {
      core.info(`TAGS: ${JSON.stringify(params.TagSpecifications)}\n-\n`);

      const result = await ec2.runInstances(params).promise();
      labelInstanceIdPairs = labelInstanceIdPairs.concat(
        (result.Instances || []).map((inst) => {
          return {
            label: config.input.label,
            ec2InstanceId: inst.InstanceId,
          };
        })
      );
      core.info(
        [
          `EC2 stats ...`,
          `${labelInstanceIdPairs.length} instances created.`,
          `${Math.round(
            (successfulPercentThreshold / 100) * totalRunners
          )} instances needed, or ${successfulPercentThreshold}% of ${totalRunners}`,
        ].join('\n')
      );

      division[currentStrategy ? 'spot' : 'reserved'] += result.Instances.length;
      successiveFailures = 0;
      currentStrategy = config.input.strategy;
    } catch (error) {
      core.warning('HFS!!!');
      core.warning(`AWS EC2 start instances error: ${JSON.stringify(error)}`);
      errors.push(error);
      // every other iteration, we will retry spot strategy if it failed because they dont have
      // capacity available in the AZ or Region
      if (
        (currentStrategy || '').toLowerCase() === 'besteffort' &&
        error.code === 'InsufficientInstanceCapacity' &&
        successiveFailures % 2 === 1
      ) {
        core.warning('FALLING BACK TO RESERVED INSTANCE');
        currentStrategy = '';
      }
      totalFailures++;
    }

    percentComplete = (labelInstanceIdPairs.length / totalRunners) * 100;
    if (percentComplete <= successfulPercentThreshold) {
      const remainingInstanceCount = totalRunners - labelInstanceIdPairs.length;
      instancesToCreate =
        remainingInstanceCount > ec2CreateBatchSize ? ec2CreateBatchSize : remainingInstanceCount;

      // if (!currentStrategy) {
      //   // do a half batch at full price
      //   instancesToCreate =
      //     ec2CreateBatchSize / 2 > remainingInstanceCount
      //       ? remainingInstanceCount
      //       : ec2CreateBatchSize / 2;
      // }

      successiveFailures += 1;

      if (successiveFailures >= maxSuccessiveFailures) {
        if (attemptNo > 3) {
          throw errors; // we've tried {successiveFailures} x {3}
        }

        core.info(
          `!!!!!!!!!!!!!!! Gonna sleep and try ${3 - attemptNo} more times !!!!!!!!!!!!!!!`
        );
        successiveFailures = 0;
        attemptNo++;

        await new Promise((resolve) => {
          setTimeout(() => {
            resolve();
          }, 5000);
        });
      }
    }
  }

  if (totalFailures >= maxTotalFailures) {
    core.info(
      [
        `\n-\n`,
        `Ok, look, we didn't get all of our instances,`,
        `but this is taking a REALLY long time.`,
        `So we're gonna proceed with the ${division.spot + division.reserved} instances we have`,
        `\n-\n`,
      ].join(' ')
    );
  }

  core.info(
    [
      '\n-\n',
      `TOTAL SPOT INSTANCES: ${division.spot}`,
      `TOTAL RESERVED INSTANCES: ${division.reserved}`,
      `That's ${Math.round(
        (division.spot / (division.reserved + division.spot)) * 100
      )}% spot pricing`,
      '\n-\n',
    ].join('\n')
  );

  return Promise.resolve(labelInstanceIdPairs);
}

async function stopEc2Instances(ec2InstanceIds) {
  let attemptNo = 1;
  const maxRetries = 5;

  const labelInstanceIdPairs = [];
  const errors = {};
  let stopRetries = 0;

  const ec2 = new AWS.EC2();
  core.info(`Stopping ${ec2InstanceIds.length} ec2 instances`);
  while (ec2InstanceIds.length && stopRetries <= maxRetries) {
    core.info('Starting while loop');
    const ec2InstanceId = ec2InstanceIds.pop();

    const params = {
      InstanceIds: [ec2InstanceId],
    };

    try {
      core.info(
        `Attempt ${stopRetries + 1} of ${maxRetries} to stop instance id: ${ec2InstanceId}`
      );
      await ec2.stopInstances(params).promise();
      core.info(`AWS EC2 instance ${ec2InstanceId} is stopped`);
      stopRetries = 0;
    } catch (error) {
      core.warning('AWS EC2 instance starting error', error);
      errors[ec2InstanceId] = errors[ec2InstanceId] || 0;
      errors[ec2InstanceId] += 1;
      stopRetries += 1;
    }

    if (stopRetries === maxRetries) {
      if (attemptNo <= 3) {
        // this means we've already tried to start the instances, and they've failed to create
        // so we'll sleep 15 seconds and try again (3 more times)
        core.info('!!!!!!!!!!!!!!! Retrying batch of failed instances !!!!!!!!!!!!!!!');

        await new Promise((resolve) => {
          setTimeout(() => {
            resolve();
          }, 15000);
        });

        Object.keys(errors).forEach((key) => ec2InstanceIds.push(key));
        attemptNo++;
      } else {
        throw errors;
      }
    }
  }

  return Promise.resolve(labelInstanceIdPairs);
}

async function terminateEc2InstancesByTags() {
  const ec2 = new AWS.EC2();
  const instanceIds = [];
  try {
    const params = {
      Filters: [
        ...config.getIndentifyingTags(),
        {
          Name: 'instance-state-name',
          Values: ['running'],
        },
      ],
    };

    let done = false;
    // let NextToken;
    while (!done) {
      const result = await ec2.describeInstances(params).promise();
      result.Reservations.forEach((r) => {
        r.Instances.forEach((inst) => {
          instanceIds.push(inst.InstanceId);
        });
      });
      if (!result.NextToken) {
        done = true;
      }
      params.NextToken = result.NextToken;
    }
  } catch (err) {
    core.warning(`ERROR describing instances: ${JSON.stringify(err)}`);
  }

  if (!instanceIds || !instanceIds.length) {
    return [];
  }

  const params = {
    InstanceIds: instanceIds,
  };

  try {
    await ec2.terminateInstances(params).promise();
    core.info(`AWS EC2 instance ${JSON.stringify(instanceIds)} are terminated`);
  } catch (error) {
    core.error(`AWS EC2 instance termination error with instances: ${JSON.stringify(instanceIds)}`);
    throw error;
  }

  return instanceIds;
}

async function waitForInstances(lableInstanceIdPairs) {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: lableInstanceIdPairs.map((l) => l.ec2InstanceId),
  };

  await ec2.waitFor('instanceRunning', params).promise();
  core.info(`ALL AWS EC2 instances are up and running`);
}

async function waitForAllInstances(lableInstanceIdPairs, count) {
  count = count === undefined ? 1 : count;
  const chunks = [];
  while (chunks.flat().length < lableInstanceIdPairs.length) {
    chunks.push(lableInstanceIdPairs.slice(0, 50));
  }
  core.info(`\n----\nWAITING FOR ALL EC2 INSTANCES TO COME UP!\n----\n`);
  let chunk;
  try {
    for (let i = 0; i < chunks.length; i++) {
      chunk = chunks[i];
      await waitForInstances(chunk);
    }
  } catch (error) {
    core.info(JSON.stringify(error));
    core.info(`AWS EC2 instances could not be started. Iteration ${count}`);
    if (count > 3) {
      core.info(`Should prob die. I've waited FAR too long, but we still have some runners`);
      return;
    } else {
      await new Promise((resolve) =>
        setTimeout(() => {
          resolve();
        }, 15000)
      );
      count++;
      return await this.waitForAllInstances(chunk, count);
    }
  }
}

module.exports = {
  startEc2Instances,
  stopEc2Instances,
  terminateEc2InstancesByTags,
  waitForAllInstances,
};
