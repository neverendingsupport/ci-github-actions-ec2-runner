const AWS = require('aws-sdk');
const core = require('@actions/core');
const config = require('./config');
const { SpotParams } = require('./spot-params');

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

async function startEc2Instances(labels, githubRegistrationToken) {
  let attemptNo = 1;
  const maxRetries = 5;

  const labelInstanceIdPairs = [];
  const errors = [];
  let totalRetries = 0;

  const ec2 = new AWS.EC2();
  core.info(`Starting ${labels.length} ec2 instances`);
  while (labels.length && totalRetries <= maxRetries) {
    core.info('Starting while loop');
    const label = labels.pop();

    const userData = buildUserDataScript(githubRegistrationToken, label);

    core.info(
      JSON.stringify(
        config.tagSpecifications.map((t) => {
          return {
            ...t,
            Tags: [...t.Tags, { Key: 'gh-runner-id', Value: label }],
          };
        })
      )
    );

    let params = {
      ImageId: config.input.ec2ImageId,
      InstanceType: config.input.ec2InstanceType,
      MinCount: 1,
      MaxCount: 1,
      UserData: Buffer.from(userData.join('\n')).toString('base64'),
      SubnetId: config.input.subnetId,
      SecurityGroupIds: [config.input.securityGroupId],
      IamInstanceProfile: { Name: config.input.iamRoleName },
      TagSpecifications: config.tagSpecifications.map((t) => {
        return {
          ...t,
          Tags: [...t.Tags, { Key: 'gh-runner-id', Value: label }],
        };
      }),
    };

    // if spot instance
    if (config.input.strategy) {
      core.info(`Starting instance with ${config.input.strategy} strategy`);
      const spotParams = new SpotParams(ec2);
      params = await spotParams.modifyInstanceConfiguration(params, config.input.strategy);
    }

    try {
      core.info(`TAGS: ${JSON.stringify(params.TagSpecifications)}`);
      core.info(
        `Attempt ${totalRetries + 1} of ${maxRetries} to start instance for label ${label}`
      );
      const result = await ec2.runInstances(params).promise();
      const ec2InstanceId = result.Instances[0].InstanceId;
      core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
      labelInstanceIdPairs.push({ label, ec2InstanceId });
      totalRetries = 0;
    } catch (error) {
      core.warning('HFS!!!');
      core.warning('AWS EC2 instance starting error', error);
      errors[label] = errors[label] || 0;
      errors[label] += 1;
      labels.push(label);
      totalRetries += 1;
    }
  }

  if (totalRetries >= maxRetries) {
    if (attemptNo <= 3) {
      // this means we've already tried to start the instances, and they've failed to create
      // so we'll sleep 15 seconds and try again (3 more times)
      core.info('!!!!!!!!!!!!!!! Retrying batch of failed instances !!!!!!!!!!!!!!!');

      await new Promise((resolve) => {
        setTimeout(() => {
          resolve();
        }, 15000);
      });

      Object.keys(errors).forEach((key) => labels.push(key));
      attemptNo++;
    } else {
      throw errors;
    }
  }

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

async function terminateEc2Instances(ec2InstanceIds) {
  let attemptNo = 1;
  const maxRetries = 5;
  const errors = {};
  let termRetries = 0;

  const ec2 = new AWS.EC2();
  core.info(`Terminating ${ec2InstanceIds.length} ec2 instances`);
  while (ec2InstanceIds.length && termRetries <= maxRetries) {
    core.info('Starting term loop');
    const ec2InstanceId = ec2InstanceIds.pop();

    const params = {
      InstanceIds: [ec2InstanceId],
    };

    try {
      core.info(
        `Attempt ${termRetries + 1} of ${maxRetries} to terminate instance id: ${ec2InstanceId}`
      );
      await ec2.terminateInstances(params).promise();
      core.info(`AWS EC2 instance ${ec2InstanceId} is terminated`);
      termRetries = 0;
    } catch (error) {
      core.warning('AWS EC2 instance termination error', error);
      errors[ec2InstanceId] = errors[ec2InstanceId] || 0;
      errors[ec2InstanceId] += 1;
      termRetries += 1;
    }
  }

  if (termRetries === maxRetries) {
    if (attemptNo <= 3) {
      // this means we've already tried to term the instance(s), and they've failed to term
      // so we'll sleep 15 seconds and try again (3 more times)
      core.info('!!!!!!!!!!!!!!! Retrying batch of failed terminations !!!!!!!!!!!!!!!');

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

async function terminateEc2Instance() {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    await ec2.terminateInstances(params).promise();
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await ec2.waitFor('instanceRunning', params).promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

async function waitForAllInstances(lableInstanceIdPairs) {
  return Promise.all(
    lableInstanceIdPairs.map((l) => {
      return waitForInstanceRunning(l.ec2InstanceId);
    })
  );
}

module.exports = {
  startEc2Instances,
  stopEc2Instances,
  terminateEc2Instance,
  terminateEc2Instances,
  waitForAllInstances,
};
