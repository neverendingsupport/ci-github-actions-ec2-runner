const core = require('@actions/core');
const github = require('@actions/github');
const _ = require('lodash');

const context = {
  owner: 'neverendingsupport',
  repo: 'ci',
};

const token = process.env.TOKEN;

async function getRunners(labels) {
  const octokit = github.getOctokit(token);

  try {
    // totalRequestsSent++;
    const runners = await octokit.paginate('GET /repos/{owner}/{repo}/actions/runners', context);

    core.info(`RESPONSE: ${JSON.stringify(runners)}`);

    const foundRunners = {};
    for (let i = 0; i < runners.length; i++) {
      const runner = runners[i];
      for (let j = 0; j < runner.labels.length; j++) {
        if (labels[0] === '*') {
          foundRunners[runner.id] = runner;
          continue;
        }

        const matches = labels.filter((label) => {
          return label === runner.labels[j].name;
        });
        if (matches.length) {
          foundRunners[runner.id] = runner;
        }
      }
    }

    if (Object.keys(foundRunners).length) {
      core.info(`FOUND RUNNERS: ${JSON.stringify(foundRunners)}`);
    } else {
      core.info('NO RUNNERS FOUND');
    }

    // core.info(`TOTAL REQUESTS SENT: ${totalRequestsSent}`);

    return Object.values(foundRunners);
  } catch (error) {
    return [];
  }
}

async function removeRunners() {
  const runners = await getRunners(['*']);
  const octokit = github.getOctokit(token);

  // // skip the runner removal process if the runner is not found
  // if (!runners || !(runners || []).length) {
  //   core.info(
  //     `GitHub self-hosted runner with label ${config.input.label} is not found, so the removal is skipped`
  //   );
  //   return;
  // }

  let firstError;
  for (const runner of runners) {
    try {
      await octokit.request(
        'DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}',
        _.merge(context, { runner_id: runner.id })
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

removeRunners();
