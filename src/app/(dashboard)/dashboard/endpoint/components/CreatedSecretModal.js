"use client";

import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

/** A newly created key, shown once with a copy button. Open while `secret` is set. */
export default function CreatedSecretModal({ secret, title, note, docsUrl, onClose }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Modal isOpen={!!secret} title={title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
          <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">Save this key now!</p>
          <p className="text-sm text-yellow-700 dark:text-yellow-300">{note}</p>
        </div>
        <div className="flex gap-2">
          <Input value={secret || ""} readOnly className="flex-1 font-mono text-sm" />
          <Button
            variant="secondary"
            icon={copied === "created_secret" ? "check" : "content_copy"}
            onClick={() => copy(secret, "created_secret")}
          >
            {copied === "created_secret" ? "Copied!" : "Copy"}
          </Button>
        </div>
        {docsUrl && (
          <p className="text-sm text-text-muted">
            Next:{" "}
            <a href={docsUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
              call the API with this key
            </a>
          </p>
        )}
        <Button onClick={onClose} fullWidth>Done</Button>
      </div>
    </Modal>
  );
}

CreatedSecretModal.propTypes = {
  secret: PropTypes.string,
  title: PropTypes.string.isRequired,
  note: PropTypes.string.isRequired,
  docsUrl: PropTypes.string,
  onClose: PropTypes.func.isRequired,
};
