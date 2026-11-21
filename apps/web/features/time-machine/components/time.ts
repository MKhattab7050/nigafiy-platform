
export const MIN = 60_000;
export const minuteNow = () => new Date(Math.floor(Date.now() / MIN) * MIN);
