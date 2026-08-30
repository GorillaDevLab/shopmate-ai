export function validateOrderQuantity(quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError("quantity must be a positive integer");
  }

  return true;
}

export function shouldIncludeOrderInSales(status) {
  return status !== "CANCELLED";
}
