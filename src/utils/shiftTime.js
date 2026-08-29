// "HH:MM" 24h IST wall-clock, shared by profileController.js (self-edit) and
// userController.js (admin/manager editing someone else's shift time).
export const SHIFT_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isValidShiftTime = (value) => value === null || SHIFT_TIME_RE.test(value);
