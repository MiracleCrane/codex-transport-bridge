# Changes

## 1.5.2

- Allow up to 180 seconds for upstream HTTP response headers after request hand-off, reducing premature retries for large contexts.
- Verify delayed headers beyond one minute and prompt cancellation while waiting. Connection setup, streaming idle and response-drain deadlines are unchanged.

## 1.5.1

- Bound initial headless-supervisor startup failure and stop supervising an exited owned runtime after the host is gone.
- Add configuration restore preflight for coordinated kit rollback.

## 1.5.0

- Publish the bridge as an independent project with source, installation documentation, fixtures and maintenance boundaries.
- Add component-only installation and a receipt-addressed supervisor so the desktop kit can own the final shortcut without another wrapper.
- Verify the installed supervisor hash alongside runtime hashes.

## 1.4.0

- Preserve received HTTP tail bytes on abnormal EOF while retaining failure semantics for incomplete responses.
- Cover native client completion/incompletion, cancellation, TLS deadlines and close draining with local fixtures.
