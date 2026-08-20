// Form Entry's "not needed" store — the meetings the user manually dismissed.
// Backed by the shared dismiss store (.data/form-dismissed.json).

import {
  readDismissed as read,
  addDismissed as add,
  removeDismissed as remove,
} from "./dismissStore";

const STORE = "form-dismissed";

export const readDismissed = () => read(STORE);
export const addDismissed = (key: string) => add(STORE, key);
export const removeDismissed = (key: string) => remove(STORE, key);
