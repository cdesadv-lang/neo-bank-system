import net from "net";
import { randomInt } from "crypto";
import type { CashCounterDevice } from "@prisma/client";
import { AppError } from "@/lib/errors";

/**
 * Cash-counting machine (banknote counter / sorter) integration.
 *
 * Each driver returns a normalised CountResult. Denomination keys are minor units
 * ("20000" = EGP 200 note). Real devices differ per model (Glory, Kisan, Magner,
 * Cassida, Julong …): protocol, framing, baud rate and serial-number support all
 * depend on the model and firmware — implement a driver per model using the vendor SDK.
 */
export type CountResult = {
  currency: "EGP" | "USD" | "EUR" | "SAR";
  denominations: Record<string, number>;
  total: bigint;
  noteCount: number;
  suspectedCounterfeits: number;
  serials?: string[];
  rawFrame?: string;
};

export interface CashCounterDriver {
  kind: "SIMULATOR" | "SERIAL" | "USB" | "TCP";
  count(opts: { currency: CountResult["currency"]; simulate?: { denominations?: Record<string, number>; counterfeits?: number } }): Promise<CountResult>;
}

export const NOTE_SERIES: Record<string, number[]> = {
  EGP: [20000, 10000, 5000, 2000, 1000, 500],
  USD: [10000, 5000, 2000, 1000, 500, 100],
  EUR: [50000, 20000, 10000, 5000, 2000, 1000, 500],
  SAR: [50000, 10000, 5000, 1000, 500],
};

function finalize(currency: CountResult["currency"], denominations: Record<string, number>, counterfeits = 0, serials?: string[], rawFrame?: string): CountResult {
  let total = 0n, notes = 0;
  for (const [d, n] of Object.entries(denominations)) {
    if (!/^\d+$/.test(d) || n < 0) throw new AppError("DEVICE_BAD_FRAME", 422, "Invalid denomination in count");
    total += BigInt(d) * BigInt(n);
    notes += n;
  }
  return { currency, denominations, total, noteCount: notes, suspectedCounterfeits: counterfeits, serials, rawFrame };
}

/** Built-in simulator: returns the requested bundle (or a random one) with fictional serial numbers. */
export class SimulatorDriver implements CashCounterDriver {
  kind = "SIMULATOR" as const;
  async count({ currency, simulate }: Parameters<CashCounterDriver["count"]>[0]) {
    let den = simulate?.denominations;
    if (!den) {
      den = {};
      for (const d of NOTE_SERIES[currency].slice(0, 3)) den[String(d)] = randomInt(0, 20);
    }
    const serials = Object.entries(den).flatMap(([d, n]) => Array.from({ length: Math.min(n, 50) }, () => `SIM${d.slice(0, 3)}${String(randomInt(0, 1e8)).padStart(8, "0")}`));
    return finalize(currency, den, simulate?.counterfeits ?? 0, serials);
  }
}

/**
 * Generic text frame understood by the TCP driver (and recommended for serial bridges):
 *   CUR=EGP;D20000=5;D10000=3;CF=0;SN=AB123,AB124\n
 */
export function parseGenericFrame(frame: string): CountResult {
  const parts = Object.fromEntries(frame.trim().split(";").filter(Boolean).map((kv) => kv.split("=") as [string, string]));
  const currency = parts.CUR as CountResult["currency"];
  if (!["EGP", "USD", "EUR", "SAR"].includes(currency)) throw new AppError("DEVICE_BAD_FRAME", 422, "Frame missing CUR");
  const den: Record<string, number> = {};
  for (const [k, v] of Object.entries(parts)) if (/^D\d+$/.test(k)) den[k.slice(1)] = Number(v);
  return finalize(currency, den, Number(parts.CF ?? 0), parts.SN ? parts.SN.split(",") : undefined, frame.trim());
}

/** TCP driver: connects to a counter (or serial-to-TCP bridge) that speaks the generic frame protocol. */
export class TcpDriver implements CashCounterDriver {
  kind = "TCP" as const;
  constructor(private address: string, private timeoutMs = 15_000) {}
  count(): Promise<CountResult> {
    const [host, port] = this.address.split(":");
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port: Number(port) });
      let buf = "";
      const t = setTimeout(() => { sock.destroy(); reject(new AppError("DEVICE_TIMEOUT", 504, "Counter did not answer")); }, this.timeoutMs);
      sock.on("connect", () => sock.write("COUNT\n"));
      sock.on("data", (d) => {
        buf += d.toString("latin1");
        if (buf.includes("\n")) {
          clearTimeout(t);
          sock.end();
          try { resolve(parseGenericFrame(buf.split("\n")[0])); } catch (e) { reject(e); }
        }
      });
      sock.on("error", (e) => { clearTimeout(t); reject(new AppError("DEVICE_ERROR", 502, `Counter connection failed: ${e.message}`)); });
    });
  }
}

/**
 * SERIAL / USB driver STUB. To implement for a given model:
 *  1. add the `serialport` package (or vendor SDK / HID library for USB),
 *  2. open the port with the model's settings (e.g. 9600 8N1),
 *  3. send the model's "report/count" command and read the vendor frame,
 *  4. map the vendor frame to CountResult (or emit the generic frame and reuse parseGenericFrame).
 * Frame formats, checksums and serial-number support are model specific.
 */
export class SerialDriverStub implements CashCounterDriver {
  constructor(public kind: "SERIAL" | "USB", private address?: string) {}
  async count(): Promise<CountResult> {
    throw new AppError("DEVICE_DRIVER_NOT_IMPLEMENTED", 501, `${this.kind} driver for ${this.address ?? "device"} is a stub; implement it for the specific counter model (see src/server/devices/cash-counter.ts)`);
  }
}

export function getCounterDriver(device: Pick<CashCounterDevice, "driver" | "address">): CashCounterDriver {
  switch (device.driver) {
    case "SIMULATOR": return new SimulatorDriver();
    case "TCP": return new TcpDriver(device.address ?? "127.0.0.1:4001");
    case "SERIAL": return new SerialDriverStub("SERIAL", device.address ?? undefined);
    case "USB": return new SerialDriverStub("USB", device.address ?? undefined);
    default: throw new AppError("DEVICE_DRIVER_UNKNOWN", 422, "Unknown driver");
  }
}
