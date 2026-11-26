import { Buttons, Modal } from "../ops/modal";
import { percentOf } from "./update_logic";
import { useUpdateStore } from "./update_store";

/** The update dialog (shared modal shell). Rendered once, while the vault is unlocked. */
export function UpdateDialog() {
  const open = useUpdateStore((state) => state.dialogOpen);
  const update = useUpdateStore((state) => state.update);
  const warning = useUpdateStore((state) => state.transferWarning);
  const waiting = useUpdateStore((state) => state.waiting);
  const store = useUpdateStore.getState();
  if (!open || update.phase === "idle" || update.phase === "checking" || update.phase === "up_to_date") return null;

  const facts = (
    <dl className="modal-facts">
      <dt>New version</dt>
      <dd>{update.version}</dd>
      <dt>Current version</dt>
      <dd>{update.currentVersion}</dd>
    </dl>
  );
  const notes = (
    <pre className="update-notes" aria-label="Release notes" tabIndex={0}>{update.notes || "No release notes."}</pre>
  );

  if (update.phase === "downloading") {
    const percent = percentOf(update);
    return (
      <Modal key="downloading" title="Downloading update">
        {facts}
        <div className="update-progress" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
          <div className={percent === null ? "update-progress-fill indeterminate" : "update-progress-fill"} style={percent === null ? undefined : { width: `${percent}%` }} />
        </div>
        <p className="muted popover-note">{percent === null ? "Downloading..." : `${percent}%`} This download cannot be canceled; it installs when it finishes.</p>
      </Modal>
    );
  }

  if (update.phase === "installed") {
    return (
      <Modal key="installed" title="Update ready" onCancel={store.closeDialog}>
        {facts}
        <p>Version {update.version} is installed. Restart the app to use it.</p>
        <Buttons>
          <button type="button" onClick={store.closeDialog}>Later</button>
          <button type="button" className="primary" data-autofocus onClick={() => void store.restart()}>Restart now</button>
        </Buttons>
      </Modal>
    );
  }

  if (update.phase === "error") {
    return (
      <Modal key="error" title="Update failed" onCancel={store.closeDialog}>
        <p className="alert-text" role="alert">{update.error}</p>
        <Buttons>
          <button type="button" data-autofocus onClick={store.closeDialog}>Close</button>
        </Buttons>
      </Modal>
    );
  }

  if (waiting) {
    return (
      <Modal key="waiting" title="Update available" onCancel={store.stopWaiting}>
        {facts}
        <p className="caution">Waiting for transfers to finish. The update downloads and installs when the queue is idle.</p>
        <Buttons>
          <button type="button" data-autofocus onClick={store.stopWaiting}>Stop waiting</button>
        </Buttons>
      </Modal>
    );
  }

  if (warning) {
    return (
      <Modal key="warning" title="Update available" onCancel={store.closeDialog}>
        {facts}
        <p className="caution">A transfer is running. Installing the update restarts the app and cancels it. You can wait for it to finish first.</p>
        <Buttons>
          <button type="button" onClick={store.closeDialog}>Cancel</button>
          <button type="button" onClick={() => void store.installAnyway()}>Install anyway</button>
          <button type="button" className="primary" data-autofocus onClick={store.waitForTransfers}>Wait for transfers</button>
        </Buttons>
      </Modal>
    );
  }

  return (
    <Modal key="available" title="Update available" onCancel={store.closeDialog}>
      {facts}
      {notes}
      <Buttons>
        <button type="button" onClick={store.closeDialog}>Cancel</button>
        <button type="button" className="primary" data-autofocus onClick={() => void store.install()}>Download and install</button>
      </Buttons>
    </Modal>
  );
}
