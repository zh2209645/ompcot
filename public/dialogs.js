/**
 * Dialogs - Handles extension UI dialogs
 */

import { t } from "./i18n.js";

export class DialogHandler {
  constructor(container, wsClient) {
    this.container = container;
    this.wsClient = wsClient;
    this.currentDialog = null;
    this.timeoutId = null;
  }

  showSelect(request) {
    this.clearCurrentDialog();

    const { id, title, options, timeout } = request;

    const dialog = document.createElement("div");
    dialog.className = "dialog";
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || t("dialog.selectTitle"))}</div>
      <div class="dialog-options" id="dialog-options"></div>
      <div class="dialog-actions">
        <button id="dialog-cancel">${t("common.cancel")}</button>
      </div>
    `;

    const optionsContainer = dialog.querySelector("#dialog-options");

    (options || []).forEach((option) => {
      const optionDiv = document.createElement("div");
      optionDiv.className = "dialog-option";
      optionDiv.textContent = option;
      optionDiv.onclick = () => {
        this.respond(id, { value: option });
      };
      optionsContainer.appendChild(optionDiv);
    });

    dialog.querySelector("#dialog-cancel").onclick = () => {
      this.respond(id, { cancelled: true });
    };

    this.showDialog(dialog, timeout, id);
  }

  showConfirm(request) {
    this.clearCurrentDialog();

    const { id, title, message, timeout } = request;

    const dialog = document.createElement("div");
    dialog.className = "dialog";
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || t("dialog.confirmTitle"))}</div>
      ${message ? `<div class="dialog-message">${this.escapeHtml(message)}</div>` : ""}
      <div class="dialog-actions">
        <button id="dialog-no">${t("dialog.no")}</button>
        <button id="dialog-yes">${t("dialog.yes")}</button>
      </div>
    `;

    dialog.querySelector("#dialog-yes").onclick = () => {
      this.respond(id, { confirmed: true });
    };

    dialog.querySelector("#dialog-no").onclick = () => {
      this.respond(id, { confirmed: false });
    };

    this.showDialog(dialog, timeout, id);
  }

  showInput(request) {
    this.clearCurrentDialog();

    const { id, title, timeout } = request;

    const dialog = document.createElement("div");
    dialog.className = "dialog";
    // F6: the input element itself is NEVER part of the innerHTML template.
    // escapeHtml() only escapes & < > (not quotes), so interpolating the
    // untrusted `placeholder` into the attribute would allow attribute
    // injection: `" onfocus="…` inside placeholder="…" injects a second
    // attribute. The input is built via DOM APIs below and `placeholder` is
    // assigned as a property — immune by construction.
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || t("dialog.inputTitle"))}</div>
      <div class="dialog-actions">
        <button id="dialog-cancel">${t("common.cancel")}</button>
        <button id="dialog-submit">${t("dialog.submit")}</button>
      </div>
    `;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "dialog-input";
    input.id = "dialog-input";
    input.placeholder =
      request.placeholder === null || request.placeholder === undefined
        ? ""
        : String(request.placeholder);
    dialog.insertBefore(input, dialog.querySelector(".dialog-actions"));

    const submit = () => {
      const value = input.value.trim();
      this.respond(id, value ? { value } : { cancelled: true });
    };

    input.addEventListener("keypress", (e) => {
      if (e.key === "Enter") submit();
    });

    dialog.querySelector("#dialog-submit").onclick = submit;
    dialog.querySelector("#dialog-cancel").onclick = () => {
      this.respond(id, { cancelled: true });
    };

    this.showDialog(dialog, timeout, id);

    // Focus input after a short delay
    setTimeout(() => input.focus(), 100);
  }

  showEditor(request) {
    this.clearCurrentDialog();

    const { id, title, timeout } = request;

    const dialog = document.createElement("div");
    dialog.className = "dialog";
    dialog.innerHTML = `
      <div class="dialog-title">${this.escapeHtml(title || t("dialog.editorTitle"))}</div>
      <div class="dialog-actions">
        <button id="dialog-cancel">${t("common.cancel")}</button>
        <button id="dialog-save">${t("common.save")}</button>
      </div>
    `;

    const textarea = document.createElement("textarea");
    textarea.className = "dialog-textarea";
    textarea.id = "dialog-textarea";
    // Property assignment, never innerHTML interpolation — see showInput (F6).
    textarea.value =
      request.prefill === null || request.prefill === undefined ? "" : String(request.prefill);
    dialog.insertBefore(textarea, dialog.querySelector(".dialog-actions"));

    dialog.querySelector("#dialog-save").onclick = () => {
      const value = textarea.value;
      this.respond(id, value ? { value } : { cancelled: true });
    };

    dialog.querySelector("#dialog-cancel").onclick = () => {
      this.respond(id, { cancelled: true });
    };

    this.showDialog(dialog, timeout, id);

    // Focus textarea after a short delay
    setTimeout(() => textarea.focus(), 100);
  }

  showNotification(request) {
    const { message, notifyType } = request;

    // Create a temporary notification element
    const notification = document.createElement("div");
    notification.className = "error-message";
    notification.textContent = `${notifyType === "error" ? "⚠️" : notifyType === "warning" ? "⚠️" : "ℹ️"} ${message}`;

    // Add to messages container temporarily
    const messagesContainer = document.getElementById("messages");
    if (messagesContainer) {
      messagesContainer.appendChild(notification);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;

      // Remove after 5 seconds
      setTimeout(() => {
        notification.remove();
      }, 5000);
    }
  }

  showDialog(dialogElement, timeout, requestId) {
    this.currentDialog = dialogElement;
    this.container.innerHTML = "";
    this.container.appendChild(dialogElement);
    this.container.classList.remove("hidden");

    // Set up timeout if specified
    if (timeout) {
      this.timeoutId = setTimeout(() => {
        this.respond(requestId, { cancelled: true });
      }, timeout);
    }
  }

  clearCurrentDialog() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    this.container.innerHTML = "";
    this.container.classList.add("hidden");
    this.currentDialog = null;
  }

  respond(id, response) {
    this.clearCurrentDialog();
    this.wsClient.send({
      type: "extension_ui_response",
      id,
      ...response,
    });
  }

  /**
   * Escape untrusted text for ELEMENT-CONTENT positions of an innerHTML
   * template (escapes & < >, but NOT quotes). Never use the result inside an
   * attribute: quote characters would allow attribute injection — build such
   * elements via DOM APIs and assign properties instead (see showInput, F6).
   */
  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}
