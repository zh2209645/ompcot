// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildLanAccessUrls,
  LAN_BIND_HOST,
  LOOPBACK_BIND_HOST,
  resolveBindHost,
} from "./embedded-server.ts";

function restoreBrokerPort(value: string | undefined) {
  if (value === undefined) delete process.env.OMCOT_BROKER_PORT;
  else process.env.OMCOT_BROKER_PORT = value;
}

function withBindEnv(
  lanBindHost: string | undefined,
  ompcotLan: string | undefined,
  run: () => void,
) {
  const previousHost = process.env.LAN_BIND_HOST;
  const previousLan = process.env.OMCOT_LAN;
  if (lanBindHost === undefined) delete process.env.LAN_BIND_HOST;
  else process.env.LAN_BIND_HOST = lanBindHost;
  if (ompcotLan === undefined) delete process.env.OMCOT_LAN;
  else process.env.OMCOT_LAN = ompcotLan;
  try {
    run();
  } finally {
    if (previousHost === undefined) delete process.env.LAN_BIND_HOST;
    else process.env.LAN_BIND_HOST = previousHost;
    if (previousLan === undefined) delete process.env.OMCOT_LAN;
    else process.env.OMCOT_LAN = previousLan;
  }
}

describe("embedded server LAN access helpers", () => {
  it("binds to loopback unless the user opts into LAN exposure", () => {
    withBindEnv(undefined, undefined, () => {
      expect(resolveBindHost()).toBe(LOOPBACK_BIND_HOST);
    });
    withBindEnv(undefined, "1", () => {
      expect(resolveBindHost()).toBe(LAN_BIND_HOST);
    });
    withBindEnv(undefined, "true", () => {
      expect(resolveBindHost()).toBe(LAN_BIND_HOST);
    });
    withBindEnv(undefined, "false", () => {
      expect(resolveBindHost()).toBe(LOOPBACK_BIND_HOST);
    });
    withBindEnv(undefined, "", () => {
      expect(resolveBindHost()).toBe(LOOPBACK_BIND_HOST);
    });
  });

  it("honors an explicit LAN_BIND_HOST verbatim", () => {
    withBindEnv("192.168.1.50", undefined, () => {
      expect(resolveBindHost()).toBe("192.168.1.50");
    });
    withBindEnv("127.0.0.1", "1", () => {
      expect(resolveBindHost()).toBe("127.0.0.1");
    });
  });

  it("builds mobile chat urls for every LAN host", () => {
    const previous = process.env.OMCOT_BROKER_PORT;
    delete process.env.OMCOT_BROKER_PORT;
    expect(buildLanAccessUrls(47821, ["192.168.1.20", "10.0.0.8"])).toEqual([
      "http://192.168.1.20:47821/?mobile=1",
      "http://10.0.0.8:47821/?mobile=1",
    ]);
    restoreBrokerPort(previous);
  });

  it("includes the LAN broker websocket url when broker port is available", () => {
    const previous = process.env.OMCOT_BROKER_PORT;
    process.env.OMCOT_BROKER_PORT = "49123";
    expect(buildLanAccessUrls(47821, ["192.168.1.20"])).toEqual([
      "http://192.168.1.20:47821/?mobile=1&brokerWs=ws%3A%2F%2F192.168.1.20%3A49123%2Fui-ws",
    ]);
    restoreBrokerPort(previous);
  });
});
