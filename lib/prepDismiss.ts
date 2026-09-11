// Meeting Prep's "not needed" store — the meetings the user manually dismissed
// off the prep list. Backed by the shared dismiss store (.data/prep-dismissed.json).

import {
  readDismissed as read,
  addDismissed as add,
  removeDismissed as remove,
} from "./dismissStore";

const STORE = "prep-dismissed";

export const readDismissed = () => read(STORE);
export const addDismissed = (key: string) => add(STORE, key);
export const removeDismissed = (key: string) => remove(STORE, key);
