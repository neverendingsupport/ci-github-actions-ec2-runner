const aws = require('./aws');
const gh = require('./gh');
const config = require('./config');
const core = require('@actions/core');

const startRetryLimit = 5;
let startRetries = 0;

function setOutput(labelInstanceIdPairs) {
  core.setOutput('labelInstanceIdPairs', JSON.stringify(labelInstanceIdPairs));
}

async function startAndRegisterRunners(labels, allRegisteredRunners) {
  allRegisteredRunners = allRegisteredRunners || [];

  const githubRegistrationToken = await gh.getRegistrationToken();
  core.info(`Generating ${labels.length} EC2 instances: ${JSON.stringify(labels)}`);

  const labelInstanceIdPairs = await aws.startEc2Instances(labels, githubRegistrationToken);

  await aws.waitForAllInstances(labelInstanceIdPairs);

  const { registered, unregistered } = await gh.waitForAllRunnersToBeRegistered(
    labelInstanceIdPairs
  );

  allRegisteredRunners = [...allRegisteredRunners, ...(registered || [])];

  try {
    if (unregistered.length) {
      if (startRetries < startRetryLimit) {
        // we tried a few times and these runners didn't start
        core.info(`${unregistered.length} failed runners`);
        await aws.stopEc2Instances(unregistered.map((lidp) => lidp.ec2InstanceId));
        await gh.removeRunners(unregistered.map((lidp) => lidp.label));
        startRetries++;
        labels = config.generateUniqueLabels(unregistered.labelInstanceIdPairs.length);
        return await startAndRegisterRunners(labels, allRegisteredRunners);
      }

      // kill all instances and runners
      await aws.stopEc2Instances(allRegisteredRunners.map((lidp) => lidp.ec2InstanceId));
      await gh.removeRunners(allRegisteredRunners.map((lidp) => lidp.label));

      // die
      core.error(
        `Retried to start a batch of runners ${startRetries} times. Failed over the ${startRetryLimit} threshold`
      );
    }
  } catch (error) {
    core.error(JSON.stringify(error));
  }

  return allRegisteredRunners;
}

async function start() {
  core.info('starting runners with the following parameters: ', JSON.stringify(config.input));
  const labels = config.generateUniqueLabels();
  const labelAndRunnerIds = await startAndRegisterRunners(labels);
  setOutput(labelAndRunnerIds);
}

async function stop() {
  await aws.terminateEc2Instance();
  await gh.removeRunners();
}

(async function () {
  try {
    config.input.mode === 'start' ? await start() : await stop();
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
  }
})();
