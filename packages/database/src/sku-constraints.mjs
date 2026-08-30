export function validateSkuInventory({ inventory, alertThreshold }) {
  if (!Number.isInteger(inventory) || inventory < 0) {
    throw new RangeError("inventory must be a non-negative integer");
  }

  if (!Number.isInteger(alertThreshold) || alertThreshold < 0) {
    throw new RangeError("alertThreshold must be a non-negative integer");
  }

  return true;
}
