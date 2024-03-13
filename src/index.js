const aws = require('./aws');
const gh = require('./gh');
const config = require('./config');
const core = require('@actions/core');

const startRetryLimit = 5;
let startRetries = 0;

function setOutput(labelInstanceIdPairs) {
  core.setOutput('labelInstanceIdPairs', JSON.stringify(labelInstanceIdPairs));
}

async function startAndRegisterRunners() {
  startRetries++;

  const githubRegistrationToken = await gh.getRegistrationToken();
  core.info(`Generating ${config.input.count} EC2 instances for label: ${config.input.label}`);

  const labelInstanceIdPairs = await aws.startEc2Instances(githubRegistrationToken);

  await aws.waitForAllInstances(labelInstanceIdPairs);

  const runnersRegisteredSuccessfully = await gh.runnersRegisteredSuccessfully(
    labelInstanceIdPairs
  );

  if (!runnersRegisteredSuccessfully && startRetries < startRetryLimit) {
    await aws.stopEc2Instances(labelInstanceIdPairs.map((lidp) => lidp.ec2InstanceId));
    await gh.removeRunners([config.input.label]);
    return await startAndRegisterRunners();
  }

  return labelInstanceIdPairs;
}

async function start() {
  core.info('starting runners with the following parameters: ', JSON.stringify(config.input));
  const labelAndRunnerIds = await startAndRegisterRunners();
  setOutput(labelAndRunnerIds);
}

async function stop() {
  await aws.terminateEc2InstancesByTags();
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
