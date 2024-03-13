const _ = require('lodash');
const { Ec2Pricing } = require('./pricing');
const core = require('@actions/core');
const config = require('./config');

class SpotParams {
  constructor(client) {
    this.client = client;
  }
  async getSubnetAz() {
    try {
      const subnets = (
        await this.client
          .describeSubnets({
            SubnetIds: [config.input.subnetId],
          })
          .promise()
      ).Subnets;
      return subnets[0].AvailabilityZone;
    } catch (error) {
      core.error(`Failed to lookup subnet az`);
      throw error;
    }
  }

  async getSpotInstancePrice(instanceType) {
    const params = {
      AvailabilityZone: await this.getSubnetAz(),
      //EndTime: new Date || 'Wed Dec 31 1969 16:00:00 GMT-0800 (PST)' || 123456789,
      InstanceTypes: [instanceType ? instanceType : config.input.ec2InstanceType],
      ProductDescriptions: [
        'Linux/UNIX',
        // 'Red Hat Enterprise Linux'
        // 'SUSE Linux'
        // 'Windows'
      ],
      StartTime: new Date(),
    };

    try {
      const spotPriceHistory = (await this.client.describeSpotPriceHistory(params).promise())
        .SpotPriceHistory;

      return Number((spotPriceHistory || [{ SpotPrice: '0' }])[0].SpotPrice);
    } catch (error) {
      core.error(`Failed to lookup spot instance price`);
      throw error;
    }
  }

  async getInstanceSizesForType(instanceClass, includeBareMetal) {
    includeBareMetal === undefined ? false : includeBareMetal;
    var params = {
      Filters: [
        {
          Name: 'instance-type',
          Values: [`${instanceClass}.*`],
        },
        {
          Name: 'bare-metal',
          Values: [`${includeBareMetal}`],
        },
      ],
      MaxResults: 99,
    };

    const instanceTypesList = [];
    let nextToken = '';
    do {
      const response = await this.client.describeInstanceTypes(params).promise();
      response.InstanceTypes.forEach(function (item) {
        if (item.InstanceType && item.VCpuInfo.DefaultCores)
          instanceTypesList.push({
            name: item.InstanceType,
            vcpu: item.VCpuInfo.DefaultCores,
          });
      });

      nextToken = response.NextToken ? response.NextToken : '';
      params = { ...params, ...{ NextToken: nextToken } };
    } while (nextToken);

    return _.orderBy(instanceTypesList, 'vcpu');
  }

  async getNextLargerInstanceType(instanceType) {
    const instanceClass = instanceType.toLowerCase().split('.')[0];
    var instanceTypeList = await this.getInstanceSizesForType(instanceClass);
    instanceTypeList = instanceTypeList.filter(function (item) {
      return !item.name.includes('metal');
    });

    const currentInstanceTypeIndex = instanceTypeList
      .map(function (e) {
        return e.name;
      })
      .indexOf(instanceType);
    const nextInstanceTypeIndex =
      currentInstanceTypeIndex + 1 < instanceTypeList.length
        ? currentInstanceTypeIndex + 1
        : currentInstanceTypeIndex;
    return instanceTypeList[nextInstanceTypeIndex].name;
  }

  async bestSpotSizeForOnDemandPrice() {
    const ec2Pricing = new Ec2Pricing(this.client);
    const currentOnDemandPrice = await ec2Pricing.getPriceForInstanceTypeUSD(
      config.input.ec2InstanceType
    );

    var previousInstanceType = config.input.ec2InstanceType;
    var bestInstanceType = config.input.ec2InstanceType;
    do {
      const nextLargerInstance = await this.getNextLargerInstanceType(bestInstanceType);
      const spotPriceForLargerInstance = await this.getSpotInstancePrice(nextLargerInstance);

      previousInstanceType = bestInstanceType;
      if (spotPriceForLargerInstance > 0 && currentOnDemandPrice > spotPriceForLargerInstance) {
        bestInstanceType = nextLargerInstance;
      }
    } while (bestInstanceType != previousInstanceType);

    return bestInstanceType;
  }

  async modifyInstanceConfiguration(params, ec2SpotInstanceStrategy) {
    function addTags(tagSpecifications, tags) {
      return tagSpecifications.map((spec) => {
        spec.Tags = spec.Tags.concat(tags);
        return spec;
      });
    }
    const ec2Pricing = new Ec2Pricing();
    const currentInstanceTypePrice = await ec2Pricing.getPriceForInstanceTypeUSD(
      config.input.ec2InstanceType
    );

    params = Object.assign(params, {
      InstanceInitiatedShutdownBehavior: 'terminate',
      InstanceMarketOptions: {},
    });

    switch (ec2SpotInstanceStrategy.toLowerCase()) {
      case 'spotonly': {
        params.InstanceMarketOptions = {
          MarketType: 'spot',
          SpotOptions: {
            InstanceInterruptionBehavior: 'terminate',
            MaxPrice: `${await this.getSpotInstancePrice(config.input.ec2InstanceType)}`,
            SpotInstanceType: 'one-time',
          },
        };
        addTags(params.TagSpecifications, [
          {
            Key: 'spot-strategy',
            Value: 'spotonly',
          },
        ]);
        break;
      }
      case 'besteffort': {
        const spotInstanceTypePrice = await this.getSpotInstancePrice(config.input.ec2InstanceType);
        if (currentInstanceTypePrice && spotInstanceTypePrice < currentInstanceTypePrice)
          params.InstanceMarketOptions = {
            MarketType: 'spot',
            SpotOptions: {
              InstanceInterruptionBehavior: 'terminate',
              MaxPrice: `${currentInstanceTypePrice}`,
              SpotInstanceType: 'one-time',
            },
          };
        addTags(params.TagSpecifications, [
          {
            Key: 'spot-strategy',
            Value: 'besteffort',
          },
        ]);
        break;
      }
      case 'maxperformance': {
        params.InstanceType = await this.bestSpotSizeForOnDemandPrice(config.input.ec2InstanceType);
        params.InstanceMarketOptions = {
          MarketType: 'spot',
          SpotOptions: {
            InstanceInterruptionBehavior: 'terminate',
            MaxPrice: currentInstanceTypePrice.toString(),
            SpotInstanceType: 'one-time',
          },
        };
        addTags(params.TagSpecifications, [
          {
            Key: 'spot-strategy',
            Value: 'maxperformance',
          },
        ]);
        break;
      }
      case 'none': {
        params.InstanceMarketOptions = {};
        addTags(params.TagSpecifications, [
          {
            Key: 'spot-strategy',
            Value: 'none',
          },
        ]);
        break;
      }
      default: {
        throw new TypeError('Invalid value for ec2_spot_instance_strategy');
      }
    }

    return params;
  }

  async getInstanceStatus(instanceId) {
    // const client = await this.getEc2Client();
    try {
      const instanceList = (
        await this.client.describeInstanceStatus({ InstanceIds: [instanceId] }).promise()
      ).InstanceStatuses;
      return instanceList[0];
    } catch (error) {
      core.error(`Failed to lookup status for instance ${instanceId}`);
      throw error;
    }
  }

  async getInstancesForTags() {
    const client = await this.getEc2Client();
    const filters = [];
    for (const tag of this.tags) {
      filters.push({
        Name: tag.Key,
        Values: [tag.Value],
      });
    }
    try {
      var params = {
        Filters: filters,
        MaxResults: 99,
      };

      const reservation = (await client.describeInstances(params).promise()).Reservations[0];
      return reservation.Instances.at(0);
    } catch (error) {
      core.error(`Failed to lookup status for instance for tags ${filters}`);
      throw error;
    }
  }

  async waitForInstanceRunningStatus(instanceId) {
    // const client = await this.getEc2Client();
    try {
      await this.client.waitFor('instanceRunning', { InstanceIds: [instanceId] }).promise();
      core.info(`AWS EC2 instance ${instanceId} is up and running`);
      return;
    } catch (error) {
      core.error(`AWS EC2 instance ${instanceId} init error`);
      throw error;
    }
  }

  async terminateInstances(instanceId) {
    const client = await this.getEc2Client();
    try {
      await client.terminateInstances({ InstanceIds: [instanceId] }).promise();
      core.info(`AWS EC2 instance ${instanceId} is terminated`);
      return;
    } catch (error) {
      core.error(`Failed terminate instance ${instanceId}`);
      throw error;
    }
  }
}

module.exports = { SpotParams };
