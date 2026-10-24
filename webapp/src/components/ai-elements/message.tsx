// Adapted from Vercel AI Elements (Apache-2.0). See LICENSE and SOURCE.md.
import type { UIMessage } from "ai";
import type { ComponentProps, HTMLAttributes } from "react";
import { memo } from "react";
import { CodeBlockCopyButton, Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { cn } from "./utils";
export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

const plugins = { code };

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      plugins={plugins}
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className
      )}
      {...props}
    />
  )
);

MessageResponse.displayName = "MessageResponse";

export const JsonResponse = memo(({ value }: { value: unknown }) => {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) return null;
  // Bound parsing and token DOM work, including inside collapsed tool details.
  if (json.length > 20_000 || json.split("\n", 301).length > 300) {
    return (
      <div className="my-4 min-w-0 rounded-xl border border-border bg-sidebar p-2">
        <div className="flex justify-end"><CodeBlockCopyButton code={json} /></div>
        <pre
          aria-label="Tool JSON"
          tabIndex={0}
          className="max-h-[400px] overflow-auto whitespace-pre rounded-md border border-border bg-background p-4 font-mono text-sm"
        >{json}</pre>
      </div>
    );
  }
  // JSON escapes newlines inside strings, so embedded fences cannot close this block.
  return <MessageResponse mode="static">{"```json\n" + json + "\n```"}</MessageResponse>;
});

JsonResponse.displayName = "JsonResponse";
