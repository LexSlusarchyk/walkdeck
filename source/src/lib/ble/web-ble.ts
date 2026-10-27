export type BleChar = {
  uuid: string;
  properties: {
    read: boolean;
    write: boolean;
    writeWithoutResponse: boolean;
    notify: boolean;
    indicate: boolean;
  };
  value: DataView | null;
  startNotifications: () => Promise<BleChar>;
  addEventListener: (type: "characteristicvaluechanged", cb: (ev: Event) => void) => void;
  readValue: () => Promise<DataView>;
  writeValue: (value: Uint8Array) => Promise<void>;
  writeValueWithoutResponse: (value: Uint8Array) => Promise<void>;
};

export type BleService = {
  uuid: string;
  getCharacteristic: (uuid: string) => Promise<BleChar>;
  getCharacteristics: () => Promise<BleChar[]>;
};

export type BleServer = {
  connected: boolean;
  getPrimaryServices: () => Promise<BleService[]>;
  disconnect: () => void;
};

export type BleDevice = {
  id: string;
  name?: string;
  gatt?: {
    connect: () => Promise<BleServer>;
    connected: boolean;
    disconnect: () => void;
  };
  addEventListener: (type: "gattserverdisconnected", cb: () => void) => void;
  removeEventListener: (type: "gattserverdisconnected", cb: () => void) => void;
};

export type BluetoothApi = {
  requestDevice: (options: {
    acceptAllDevices?: boolean;
    filters?: Array<{ namePrefix?: string; services?: string[] }>;
    optionalServices?: string[];
  }) => Promise<BleDevice>;
  getDevices?: () => Promise<BleDevice[]>;
};

declare global {
  interface Navigator {
    bluetooth?: BluetoothApi;
  }
}

export async function writeChar(ch: BleChar, data: Uint8Array, preferResponse: boolean) {
  if (preferResponse && ch.properties.write) {
    await ch.writeValue(data);
    return;
  }
  if (ch.properties.writeWithoutResponse) {
    try {
      await ch.writeValueWithoutResponse(data);
      return;
    } catch {
      /* some stacks advertise it and then refuse */
    }
  }
  await ch.writeValue(data);
}

export function onNotify(ch: BleChar, handler: (view: DataView) => void) {
  ch.addEventListener("characteristicvaluechanged", (ev) => {
    const value = (ev.target as BleChar | null)?.value;
    if (value) handler(value);
  });
}

export async function readText(ch: BleChar): Promise<string> {
  const view = await ch.readValue();
  return new TextDecoder()
    .decode(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
    .replaceAll("\0", "")
    .trim();
}

export function shortUuid(uuid: string): string {
  const hex = uuid.toLowerCase();
  if (hex.startsWith("0000") && hex.endsWith("-0000-1000-8000-00805f9b34fb")) {
    return hex.slice(4, 8);
  }
  return hex.slice(0, 8);
}

const permitted = new Map<string, BleDevice>();

export async function listPermitted(): Promise<Array<{ id: string; name: string }>> {
  const bluetooth = navigator.bluetooth;
  if (!bluetooth?.getDevices) return [];
  try {
    const devices = await bluetooth.getDevices();
    permitted.clear();
    for (const device of devices) permitted.set(device.id, device);
    return devices.map((device) => ({ id: device.id, name: device.name || "Walking pad" }));
  } catch {
    return [];
  }
}

export function permittedDevice(id: string): BleDevice | null {
  return permitted.get(id) ?? null;
}

export function pickPermitted(
  devices: Array<{ id: string; name: string }>,
  saved: { id: string; name: string },
) {
  if (devices.length === 0) return null;
  const name = saved.name.trim().toLowerCase();
  return (
    devices.find((device) => saved.id && device.id === saved.id) ??
    devices.find((device) => name && device.name.trim().toLowerCase() === name) ??
    (devices.length === 1 ? devices[0] : null)
  );
}
