function findCorrectPricing(instanceType, list) {
  const description = `On Demand Linux ${instanceType} Instance Hour`.toLowerCase();

  for (let i = 0; i < list.length; i++) {
    const onDemand = list[i].terms.OnDemand;
    if (onDemand) {
      const onDemandKeys = Object.keys(onDemand);
      for (let j = 0; j < onDemandKeys.length; j++) {
        const onDemandItem = onDemand[onDemandKeys[j]];
        const pricingDimensions = onDemandItem.priceDimensions;
        if (pricingDimensions) {
          const pricingDimensionsKeys = Object.keys(pricingDimensions);
          for (let k = 0; k < pricingDimensionsKeys.length; k++) {
            const dimensionItem = pricingDimensions[pricingDimensionsKeys[k]];
            if (
              dimensionItem.description &&
              dimensionItem.description.toLowerCase().indexOf(description) !== -1
            ) {
              return +(dimensionItem.pricePerUnit.USD || '0');
            }
          }
        }
      }
    }
  }
  return 0;
}

function assertIsError(error) {
  if (!(error instanceof Error)) {
    throw error;
  }
}

module.exports = {
  assertIsError,
  findCorrectPricing,
};
