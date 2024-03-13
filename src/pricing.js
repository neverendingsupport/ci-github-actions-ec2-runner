const { findCorrectPricing } = require('./utils/utils');
const core = require('@actions/core');
const config = require('./config');
const AWS = require('aws-sdk');

class Ec2Pricing {
  constructor() {
    this.client = new AWS.Pricing();
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

  async getPriceForInstanceTypeUSD(instanceType) {
    // const client = await this.getEc2Client();

    var params = {
      Filters: [
        {
          Type: 'TERM_MATCH',
          Field: 'ServiceCode',
          Value: 'AmazonEC2',
        },
        {
          Type: 'TERM_MATCH',
          Field: 'regionCode',
          Value: process.env.AWS_REGION,
        },
        {
          Type: 'TERM_MATCH',
          Field: 'marketoption',
          Value: 'OnDemand',
        },
        {
          Type: 'TERM_MATCH',
          Field: 'instanceType',
          Value: instanceType,
        },
        {
          Type: 'TERM_MATCH',
          Field: 'operatingSystem',
          Value: 'Linux',
        },
        {
          Type: 'TERM_MATCH',
          Field: 'licenseModel',
          Value: 'No License required',
        },
        {
          Type: 'TERM_MATCH',
          Field: 'preInstalledSw',
          Value: 'NA',
        },
      ],
      FormatVersion: 'aws_v1',
      MaxResults: 99,
      ServiceCode: 'AmazonEC2',
    };

    return new Promise((resolve, reject) => {
      this.client.getProducts(params, (err, data) => {
        if (err) {
          return reject(err);
        }

        if (data.PriceList) {
          const pricingResult = findCorrectPricing(instanceType, data.PriceList);
          return resolve(pricingResult);
        }

        resolve(0);
      });
    });
  }
}

module.exports = {
  Ec2Pricing,
};
