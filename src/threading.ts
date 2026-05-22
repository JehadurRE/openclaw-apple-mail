import { type ChannelThreadingAdapter } from "openclaw/plugin-sdk";

export const appleMailThreading: ChannelThreadingAdapter = {
  buildToolContext: ({ context, hasRepliedRef }) => ({
    currentThreadTs: context.ReplyToId,
    currentThreadId: context.MessageThreadId,
    currentSender: context.SenderId,
    hasRepliedRef,
  }),
};
