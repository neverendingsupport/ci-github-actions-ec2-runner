const core = require('@actions/core');
const github = require('@actions/github');
const _ = require('lodash');
const config = require('./config');
let totalRequestsSent = 0;
// use the unique label to find the runner
// as we don't have the runner's id, it's not possible to get it in any other way
async function getRunners(labels) {
  const octokit = github.getOctokit(config.input.githubToken);

  try {
    totalRequestsSent++;
    const runners = await octokit.paginate(
      'GET /repos/{owner}/{repo}/actions/runners',
      config.githubContext
    );

    core.info(`RESPONSE: ${JSON.stringify(runners)}`);
    const foundLabels = [];
    const foundRunners = {};
    for (let i = 0; i < runners.length; i++) {
      const runner = runners[i];
      for (let j = 0; j < labels.length; j++) {
        if (!labels[j]) {
          core.info(
            `!!!!!!!!!!!!!!!!!!!!!!!!!!! labels[j] undefined: ${j}: ${JSON.stringify(labels)}`
          );
          continue;
        }
        const matches = runner.labels.filter((l) => l.name === labels[j]);
        if (matches.length) {
          foundRunners[runner.id] = runner;
          foundLabels.push(labels[j]);
        }
      }
    }

    if (foundLabels.length !== labels.length) {
      const remainingLabels = [];
      for (let i = 0; i < labels.length; i++) {
        if (foundLabels.indexOf(labels[i]) === -1) {
          remainingLabels.push(labels);
        }
      }
      core.info(`Labels ${JSON.stringify(remainingLabels)} not found in github runners`);
    }

    if (Object.keys(foundRunners).length) {
      core.info(`FOUND RUNNERS WITH LABELS: ${JSON.stringify(foundRunners)}`);
    } else {
      core.info('NO RUNNERS FOUND WITH LABELS NEEDED');
    }

    core.info(`TOTAL REQUESTS SENT: ${totalRequestsSent}`);

    return foundRunners;
  } catch (error) {
    return null;
  }
}

// get GitHub Registration Token for registering a self-hosted runner
async function getRegistrationToken() {
  const octokit = github.getOctokit(config.input.githubToken);

  try {
    totalRequestsSent++;
    const response = await octokit.request(
      'POST /repos/{owner}/{repo}/actions/runners/registration-token',
      config.githubContext
    );
    core.info('GitHub Registration Token is received');
    return response.data.token;
  } catch (error) {
    core.error('GitHub Registration Token receiving error');
    throw error;
  }
}

async function removeRunners(labels) {
  const labelsToRemove = labels || [config.input.label];
  const runners = Object.values(await getRunners(labelsToRemove));
  const octokit = github.getOctokit(config.input.githubToken);

  // skip the runner removal process if the runner is not found
  if (!runners || !(runners || []).length) {
    core.info(
      `GitHub self-hosted runner with label ${JSON.stringify(
        labelsToRemove
      )} is not found, Skipping removal`
    );
    return;
  }

  let firstError;
  for (const runner of runners) {
    try {
      await octokit.request(
        'DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}',
        _.merge(config.githubContext, { runner_id: runner.id })
      );
      core.info(`GitHub self-hosted runner ${runner.name} is removed`);
      return;
    } catch (error) {
      core.error(`GitHub self-hosted runner removal error: ${error}`);
      if (!firstError) {
        firstError = error;
      }
    }
  }
  if (firstError) {
    throw firstError;
  }
}

async function getRegisteredAndUnregisteredGHRunners(labelInstanceIdPairs) {
  const registeredHash = {};
  const unregisteredHash = {};
  const runnersHash = (await getRunners(labelInstanceIdPairs.map((lidp) => lidp.label))) || [
    { labels: [] },
  ];

  core.info(`Runners registered: ${JSON.stringify(runnersHash)}`);

  // add registered runners to registeredHash, keyed by label
  for (let i = 0; i < labelInstanceIdPairs.length; i++) {
    const runners = Object.values(runnersHash);
    for (let j = 0; j < runners.length; j++) {
      const runner = runners[j];
      for (let k = 0; k < runner.labels.length; k++) {
        const label = runner.labels[k];
        if (label.name === labelInstanceIdPairs[i].label) {
          const index = labelInstanceIdPairs.map((lidp) => lidp.label).indexOf(label.name);
          if (index > -1) {
            registeredHash[labelInstanceIdPairs[i].label] = labelInstanceIdPairs[i];
          }
        }
      }
    }
  }

  for (let i = 0; i < labelInstanceIdPairs.length; i++) {
    if (!registeredHash[labelInstanceIdPairs[i].label]) {
      unregisteredHash[labelInstanceIdPairs[i].label] = labelInstanceIdPairs[i];
    }
  }

  return {
    registered: Object.values(registeredHash),
    unregistered: Object.values(unregisteredHash),
  };
}

async function waitForAllRunnersToBeRegistered(labelInstanceIdPairs) {
  const timeoutMinutes = 1;
  const retryIntervalSeconds = 15;
  let waitSeconds = 0;

  core.info(
    `Checking Github every ${retryIntervalSeconds}s to see if the self-hosted runners are registered ${JSON.stringify(
      labelInstanceIdPairs
    )}`
  );

  let runnersToRegister = labelInstanceIdPairs; // try to register ALL
  let registeredRunners = []; // bucket for successful runners
  let unregisteredRunners = []; // bucket for runners that failed to register

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      const { registered, unregistered } = await getRegisteredAndUnregisteredGHRunners(
        runnersToRegister
      );

      registeredRunners = [...registeredRunners, ...(registered || [])];

      unregisteredRunners = unregistered;

      // if we have any runners not yet registered
      if (unregisteredRunners.length) {
        runnersToRegister = unregisteredRunners;
        waitSeconds += retryIntervalSeconds;

        // all runners registered
      } else if (registeredRunners.length === labelInstanceIdPairs.length) {
        clearInterval(interval);
        return resolve({
          registered: registeredRunners || [],
          unregistered: unregisteredRunners || [],
        });
      }

      if (waitSeconds > timeoutMinutes * 60) {
        clearInterval(interval);
        return resolve({
          registered: registeredRunners || [],
          unregistered: unregisteredRunners || [],
        });
      }

      core.info(
        `Checking... Still need the following runners: ${JSON.stringify(runnersToRegister)}`
      );
    }, retryIntervalSeconds * 1000);
  });
}

module.exports = {
  getRegistrationToken,
  removeRunners,
  waitForAllRunnersToBeRegistered,
};
