const core = require('@actions/core');
const github = require('@actions/github');

const defaultTagLabels = [
  { key: 'gh-runner-label', value: (c) => c.input.label },
  { key: 'gh-spot-strategy', value: (c) => c.input.strategy },
];

class Config {
  constructor() {
    try {
      this.input = {
        mode: core.getInput('mode'),
        githubToken: core.getInput('github-token'),
        ec2ImageId: core.getInput('ec2-image-id'),
        ec2InstanceType: core.getInput('ec2-instance-type'),
        subnetId: core.getInput('subnet-id'),
        securityGroupId: core.getInput('security-group-id'),
        label: core.getInput('label'),
        ec2InstanceId: core.getInput('ec2-instance-id'),
        iamRoleName: core.getInput('iam-role-name'),
        runnerHomeDir: core.getInput('runner-home-dir'),
        preRunnerScript: core.getInput('pre-runner-script'),
        strategy: core.getInput('spot-instance-strategy'),
        count: +core.getInput('count'),
      };

      this.awsTags = JSON.parse(core.getInput('aws-resource-tags') || '[]') || [];
      this.tagSpecifications = [];
      if (this.awsTags.length) {
        this.tagSpecifications = [
          { ResourceType: 'instance', Tags: this.awsTags },
          { ResourceType: 'volume', Tags: this.awsTags },
        ];
      }

      this.addTags((defaultTagLabels || []).map((t) => ({ Key: t.key, Value: t.value(this) })));

      // the values of github.context.repo.owner and github.context.repo.repo are taken from
      // the environment variable GITHUB_REPOSITORY specified in "owner/repo" format and
      // provided by the GitHub Action on the runtime
      this.githubContext = {
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
      };

      //
      // validate input
      //

      if (!this.input.mode) {
        throw new Error(`The 'mode' input is not specified`);
      }

      if (!this.input.githubToken) {
        throw new Error(`The 'github-token' input is not specified`);
      }

      if (this.input.mode === 'start') {
        if (
          !this.input.ec2ImageId ||
          !this.input.ec2InstanceType ||
          // !this.input.subnetId ||
          !this.input.securityGroupId
        ) {
          throw new Error(`Not all the required inputs are provided for the 'start' mode`);
        }
      } else if (this.input.mode === 'stop') {
        if (!this.input.label) {
          throw new Error(`Not all the required inputs are provided for the 'stop' mode`);
        }
      } else {
        throw new Error('Wrong mode. Allowed values: start, stop.');
      }
    } catch (err) {
      core.error(err);
      core.error(`ERROR loading config: ${JSON.stringify(err)}`);
      throw err;
    }
  }

  addTags(tags) {
    this.tagSpecifications = (this.tagSpecifications || []).map((spec) => {
      spec.Tags = (spec.Tags || []).concat(tags);
      return spec;
    });
  }

  getIndentifyingTags() {
    return [
      ...(defaultTagLabels || [])
        // exclude spot strategy in case any instances are created without spot-strategy
        .filter((t) => t.key !== 'gh-spot-strategy')
        .map((t) => {
          return {
            Name: `tag:${t.key}`,
            Values: [t.value(this)],
          };
        }),
      ...(this.awsTags || []).map((t) => {
        return {
          Name: `tag:${t.Key}`,
          Values: [t.Value],
        };
      }),
    ];
  }

  generateUniqueLabels(noOfLabels) {
    const count = noOfLabels || this.input.count;
    // return Math.random().toString(36).slice(2, 7);
    const labels = [];
    core.info(`Generating ${count} runner labels`);
    for (let i = 0; i < (count || 0); i++) {
      labels.push(Math.random().toString(36).slice(2, 7));
    }
    return labels;
  }
}

try {
  module.exports = new Config();
} catch (error) {
  core.error(error);
  core.setFailed(error.message);
}
