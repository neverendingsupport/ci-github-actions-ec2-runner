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

async function runnersRegisteredSuccessfully(labelInstanceIdPairs) {
  const timeoutMinutes = 1;
  const retryIntervalSeconds = 15;
  let waitSeconds = 0;

  core.info(
    `Checking Github every ${retryIntervalSeconds}s to see if the self-hosted runners are registered ${JSON.stringify(
      labelInstanceIdPairs
    )}`
  );

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      const runnersHash = await getRunners([config.input.label]);
      const uniqueRunners = Object.values(runnersHash);
      const onlineRunners = uniqueRunners.filter((runner) => runner.status === 'online');
      const labelMatchedRunnersCount = onlineRunners.length;

      if (labelMatchedRunnersCount >= labelInstanceIdPairs.length) {
        core.info(`The runners... We got em! Let's GTFOH, babay!!!`);
        clearInterval(interval);
        return resolve(true);
      }
      waitSeconds += retryIntervalSeconds;

      if (waitSeconds > timeoutMinutes * 60) {
        clearInterval(interval);
        return resolve(false);
      }

      const remainingRunnersCount = labelInstanceIdPairs.length - labelMatchedRunnersCount;

      core.info(`Checking Again... Still need ${remainingRunnersCount} more runners.`);
    }, retryIntervalSeconds * 1000);
  });
}

module.exports = {
  getRegistrationToken,
  removeRunners,
  runnersRegisteredSuccessfully,
};
