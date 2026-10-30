import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";
import Constants from "expo-constants";

import { formatConnectionLog, makeConnectionLog } from "./connection-log";

const KEY = "t3code.connection-history.v1";
export const connectionLog = makeConnectionLog({
  read: () => AsyncStorage.getItem(KEY),
  write: (value) => AsyncStorage.setItem(KEY, value),
});

export async function readConnectionReport(environmentId?: string) {
  return formatConnectionLog(await connectionLog.read(environmentId), {
    version: Constants.expoConfig?.version ?? "unknown",
    build: Application.nativeBuildVersion ?? "dev",
  });
}
