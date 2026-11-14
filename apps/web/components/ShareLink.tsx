"use client";
import { useState } from "react";
import { encodeShare, shareUrl } from "../lib/share.ts";
import { Button } from "./ui.tsx";

/**
 * "Copy share link" for a verified receipt: a /verify link that carries the receipt in its fragment, so
 * a donor, auditor or payee opens it and sees the checks run, with nothing to download.
 */
export function ShareLink({
  text,
  copy = (s: string) => navigator.clipboard.writeText(s),
  origin,
}: {
  text: string;
  copy?: (s: string) => Promise<void>;
  origin?: string;
}) {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const make = async () => {
    const url = shareUrl(origin ?? window.location.origin, await encodeShare(text));
    setLink(url);
    try {
      await copy(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        <Button variant="secondary" onClick={make}>
          Copy share link
        </Button>
        {link && <span className="muted small">{copied ? "Link copied." : "Copy the link below."}</span>}
      </div>
      {link && (
        <>
          <input aria-label="Share link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <p className="muted small">
            Anyone who opens it sees this receipt checked against the chain. The receipt travels in the part
            of the link after #, which browsers don't send to any server.
          </p>
        </>
      )}
    </div>
  );
}
