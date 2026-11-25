import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { z } from "zod";

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: "idle-worker-reminder",
    version: 1,
    schema: z.object({ text: z.string(), at: z.string() }),
    Component: ({ data, theme }: any) => (
      <View style={{ paddingVertical: 6 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>{data.text}</Text>
      </View>
    ),
  });
  return () => {};
}
