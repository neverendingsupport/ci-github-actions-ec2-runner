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

async function startEc2Instances(githubRegistrationToken, instancesToCreate) {
  let attemptNo = 1;
  const maxRetries = 5;

  let labelInstanceIdPairs = [];
  const errors = [];
  let totalRetries = 0;

  const ec2 = new AWS.EC2();
  core.info(`Starting ${config.input.count} ec2 instances`);
  let notYetStarted = true;
  instancesToCreate = instancesToCreate || config.input.count;
  while (notYetStarted && totalRetries <= maxRetries) {
    core.info('Starting while loop');

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
    if (config.input.strategy) {
      core.info(`Starting instance with ${config.input.strategy} strategy`);
      const spotParams = new SpotParams(ec2);
      params = await spotParams.modifyInstanceConfiguration(params, config.input.strategy);
    }

    try {
      core.info(`TAGS: ${JSON.stringify(params.TagSpecifications.Tags)}\n-\n`);
      core.info(
        `Attempt ${totalRetries + 1} of ${maxRetries} to start instances for label ${
          config.input.label
        }`
      );
      const result = await ec2.runInstances(params).promise();
      labelInstanceIdPairs = labelInstanceIdPairs.concat(
        (result.Instances || []).map((inst) => {
          return {
            label: config.input.label,
            ec2InstanceId: inst.InstanceId,
          };
        })
      );
      core.info(`${labelInstanceIdPairs.length} AWS EC2 instances have been started`);
      totalRetries = 0;
    } catch (error) {
      core.warning('HFS!!!');
      core.warning(`AWS EC2 start instances error: ${JSON.stringify(error)}`);
    }

    if (labelInstanceIdPairs.length < config.input.count) {
      instancesToCreate = config.input.count - labelInstanceIdPairs.length;
      notYetStarted = true;
      totalRetries += 1;
    } else {
      notYetStarted = false; // we've started all our instances
    }
  }

  if (totalRetries >= maxRetries) {
    if (attemptNo <= 3) {
      // this means we've already tried to start the instances, and they've failed to create
      // so we'll sleep 5 seconds and try again (3 more times)
      core.info('!!!!!!!!!!!!!!! Retrying batch of failed instances !!!!!!!!!!!!!!!');

      await new Promise((resolve) => {
        setTimeout(() => {
          resolve();
        }, 5000);
      });

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

// async function terminateEc2Instances(ec2InstanceIds) {
//   let attemptNo = 1;
//   const maxRetries = 5;
//   const errors = {};
//   let termRetries = 0;

//   const ec2 = new AWS.EC2();
//   core.info(`Terminating ${ec2InstanceIds.length} ec2 instances`);
//   while (ec2InstanceIds.length && termRetries <= maxRetries) {
//     core.info('Starting term loop');
//     const ec2InstanceId = ec2InstanceIds.pop();

//     const params = {
//       InstanceIds: [ec2InstanceId],
//     };

//     try {
//       core.info(
//         `Attempt ${termRetries + 1} of ${maxRetries} to terminate instance id: ${ec2InstanceId}`
//       );
//       await ec2.terminateInstances(params).promise();
//       core.info(`AWS EC2 instance ${ec2InstanceId} is terminated`);
//       termRetries = 0;
//     } catch (error) {
//       core.warning('AWS EC2 instance termination error', error);
//       errors[ec2InstanceId] = errors[ec2InstanceId] || 0;
//       errors[ec2InstanceId] += 1;
//       termRetries += 1;
//     }
//   }

//   if (termRetries === maxRetries) {
//     if (attemptNo <= 3) {
//       // this means we've already tried to term the instance(s), and they've failed to term
//       // so we'll sleep 15 seconds and try again (3 more times)
//       core.info('!!!!!!!!!!!!!!! Retrying batch of failed terminations !!!!!!!!!!!!!!!');

//       await new Promise((resolve) => {
//         setTimeout(() => {
//           resolve();
//         }, 15000);
//       });

//       Object.keys(errors).forEach((key) => ec2InstanceIds.push(key));
//       attemptNo++;
//     } else {
//       throw errors;
//     }
//   }
// }

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

  const params = {
    InstanceIds: instanceIds, //[config.input.ec2InstanceId],
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
  terminateEc2InstancesByTags,
  waitForAllInstances,
};
