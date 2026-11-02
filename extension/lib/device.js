// The ID of this browser profile ("device"). It is random and made one time,
// when the extension first needs it. An update of the extension keeps it. A
// new install makes a new ID. Export and import do not include it.

export const DEVICE_KEY = 'device';

let pending = null;

/** Returns the device ID. Makes and keeps it if it does not exist. */
export async function getDeviceId(area, makeId = () => crypto.randomUUID()) {
  const got = await area.get(DEVICE_KEY);
  if (got[DEVICE_KEY]?.id) return got[DEVICE_KEY].id;
  // Two calls at the same time in one context must give the same ID.
  pending ??= (async () => {
    const device = { id: makeId(), createdAt: new Date().toISOString() };
    await area.set({ [DEVICE_KEY]: device });
    return device.id;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}
