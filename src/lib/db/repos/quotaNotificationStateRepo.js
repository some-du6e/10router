import { makeKv } from "../helpers/kvStore.js";

const stateStore = makeKv("quotaNotificationState");

export async function getQuotaNotificationState(connectionId) {
  return await stateStore.get(connectionId, { quotas: {} });
}

export async function setQuotaNotificationState(connectionId, state) {
  await stateStore.set(connectionId, state);
}

export async function deleteQuotaNotificationState(connectionId) {
  await stateStore.remove(connectionId);
}
