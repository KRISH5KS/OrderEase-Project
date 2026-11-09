export function calculateLine({ quantity, price, scheme }) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) throw new Error('Quantity must be between 1 and 500 cases.');
  const gross = quantity * price;
  let freeQuantity = 0, discount = 0;
  if (scheme?.type === 'free' && quantity >= scheme.threshold) freeQuantity = Math.floor(quantity / scheme.threshold) * scheme.value;
  if (scheme?.type === 'discount' && quantity >= scheme.threshold) discount = gross * (scheme.value / 100);
  return { gross, freeQuantity, discount, total: gross - discount };
}
