import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle } from "lucide-react";

interface LocalApiStatus {
  enabled: boolean;
  state: "starting" | "listening" | "portInUse" | "tokenFileError" | "bindError";
  bindAddr: string;
  port: number;
  tokenFilePath: string | null;
}

const STATUS_LABELS: Record<LocalApiStatus["state"], string> = {
  starting: "Starting",
  listening: "Active",
  portInUse: "Disabled (Port In Use)",
  tokenFileError: "Disabled (Token File Error)",
  bindError: "Disabled (Bind Error)",
};

export function LocalApiSection() {
  const [status, setStatus] = useState<LocalApiStatus | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    invoke<LocalApiStatus>("get_local_api_status")
      .then(setStatus)
      .catch((err) => {
        console.error("Failed to get local API status:", err);
        setError(true);
      });
  }, []);

  return (
    <section>
      <h3 className="text-lg font-semibold mb-0">Local HTTP API</h3>
      <p className="text-sm text-muted-foreground mb-2">
        Read-only usage data on the loopback interface
      </p>
      <div className="bg-muted/50 rounded-lg p-3 space-y-2 text-sm">
        {error ? (
          <p className="font-medium text-foreground">Unable To Read API Status</p>
        ) : status === null ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Checking Status...
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Status</span>
              <span
                className={
                  status.state === "listening"
                    ? "font-medium text-foreground"
                    : status.state === "starting"
                      ? "text-muted-foreground"
                      : "font-medium text-foreground underline decoration-dashed underline-offset-4"
                }
              >
                {STATUS_LABELS[status.state]}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Address</span>
              <code className="text-xs">{status.bindAddr}</code>
            </div>
            {status.tokenFilePath && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Token File</span>
                <code className="text-xs truncate max-w-[200px]" title={status.tokenFilePath}>
                  {status.tokenFilePath}
                </code>
              </div>
            )}
            {status.state === "portInUse" && (
              <p className="border-l border-dashed pl-2 pt-1 text-xs text-muted-foreground">
                Another process is using port {status.port}. The API will retry on next launch.
              </p>
            )}
            {status.state === "tokenFileError" && (
              <p className="border-l border-dashed pl-2 pt-1 text-xs text-muted-foreground">
                The API token could not be stored securely. Check the app logs for details.
              </p>
            )}
            {status.state === "bindError" && (
              <p className="border-l border-dashed pl-2 pt-1 text-xs text-muted-foreground">
                The API could not start. Check the app logs for details.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
