// Gemini has no verified network capture contract. Keep all site DOM knowledge
// here; the existing delivery/turn tracker owns sequencing and acknowledgements.
(function (root) {
  root.SyncZoteroGemini = {
    createAdapter({ document, isVisibleElement, htmlToMarkdown, shared }) {
      const composerSelector = '.ql-editor[role="textbox"][contenteditable="true"]';
      const inputRoot = () => document.querySelector(composerSelector)?.closest("input-container") || document.querySelector("input-container");
      const iconButton = (icon) => {
        const button = inputRoot()?.querySelector(`mat-icon[fonticon="${icon}"]`)?.closest("button");
        return button && isVisibleElement(button) ? button : null;
      };
      const messageRole = (node) => node?.localName === "user-query" ? "user" : node?.localName === "model-response" ? "assistant" : null;
      const messageId = (node) => {
        const id = node?.closest(".conversation-container[id]")?.id;
        const role = messageRole(node);
        return id && role ? `${id}:${role}` : null;
      };
      const clean = (node) => {
        const clone = node.cloneNode(true);
        clone.querySelectorAll('button, [role="button"], [hidden], [aria-hidden="true"], .cdk-visually-hidden, .source-inline-chip-container, source-inline-chip, sources-list, .sources-list').forEach((el) => el.remove());
        return clone;
      };
      const withExtension = (stem, extension) => {
        if (!stem) return "";
        const suffix = String(extension || "").trim().toLowerCase();
        return suffix && !stem.toLowerCase().endsWith(`.${suffix}`) ? `${stem}.${suffix}` : stem;
      };
      const getComposerAttachments = () => Array.from(inputRoot()?.querySelectorAll("uploader-file-preview") || [])
        .filter(isVisibleElement)
        .map((node) => {
          const filename = withExtension(node.querySelector(".gem-attachment-text")?.textContent.trim(), node.querySelector(".gem-attachment-extension-label")?.textContent);
          const image = Boolean(node.querySelector('gem-media-attachment img'));
          const closeButton = node.querySelector('mat-icon[fonticon="close"]')?.closest("button") || node.querySelector('button[aria-label^="close"]');
          const busy = node.querySelector('mat-progress-spinner, mat-spinner, progress, [role="progressbar"], [aria-busy="true"]');
          const failed = node.querySelector('[role="alert"], .upload-error') || /upload failed|上传失败/i.test(node.textContent);
          return { node, filename: filename || (image ? "image" : (busy || closeButton ? "pending attachment" : "")), kind: image ? "image" : "file", ready: Boolean((filename || image) && closeButton && !closeButton.disabled && closeButton.getAttribute("aria-disabled") !== "true" && !busy && !failed) };
        }).filter((card) => card.filename);
      return {
        siteId: "gemini", homeUrl: "https://gemini.google.com/app", answerCapture: "dom",
        composerSelectors: [composerSelector],
        sendButtonSelectors: () => iconButton("arrow_upward"),
        findStopButton: () => iconButton("stop"),
        findUploadControl: () => iconButton("plus"),
        stopButtonSelectors: [],
        userMessageSelector: ".conversation-container user-query",
        assistantMessageSelectors: [".conversation-container model-response"],
        conversationMessageSelector: ".conversation-container user-query, .conversation-container model-response",
        conversationTurnSelector: ".conversation-container",
        getMessageRole: messageRole, getMessageId: messageId,
        extractUserMessageText(node) {
          return Array.from(node.querySelectorAll(".query-text-line")).map((line) => htmlToMarkdown(clean(line).innerHTML).trim()).join("\n").trim();
        },
        extractAssistantAnswerText(node) {
          const markdown = node?.querySelector("message-content .markdown");
          return markdown ? htmlToMarkdown(clean(markdown).innerHTML).trim() : "";
        },
        extractAssistantThinkingText: () => "",
        extractAttachmentNames(node) {
          if (messageRole(node) !== "user") return [];
          const names = Array.from(node.querySelectorAll('user-query-file-preview [data-test-id="uploaded-file"]')).map((card) => withExtension(card.querySelector('[data-test-id="filename-label"]')?.textContent.trim(), card.querySelector(".extension-label")?.textContent)).filter(Boolean);
          const images = node.querySelectorAll('user-query-file-preview img, user-query-media img');
          images.forEach((_, index) => names.push(images.length === 1 ? "image" : `image_${index + 1}`));
          return names;
        },
        isResponseComplete(assistantTurnKey) {
          if (!assistantTurnKey) return false;
          const node = Array.from(document.querySelectorAll(".conversation-container model-response")).find((candidate) => messageId(candidate) === assistantTurnKey);
          return Boolean(node && isVisibleElement(node) && node.querySelector('message-content .markdown[aria-busy="false"]') && node.querySelector(".response-footer.complete"));
        },
        getComposerAttachments,
        classifySubmittedAttachments(attachments, expectedFilename) {
          const contract = shared.classifySubmittedPdfContract(attachments, expectedFilename);
          // Gemini exposes the complete filename stem and extension separately.
          // Its receipt must not inherit legacy substring/elision/rename matches.
          const normalizeFilename = (name) => String(name || "").normalize("NFC").trim();
          const filenameMatched = expectedFilename
            ? attachments.some((name) => normalizeFilename(name) === normalizeFilename(expectedFilename))
            : null;
          return { ...contract, filenameMatched, contractVerified: expectedFilename
            ? contract.pdfAttachmentCount === 1 && filenameMatched === true
            : attachments.length === 0 || attachments.every((name) => /^image(?:_\d+)?$/.test(name)) };
        },
        async uploadFile(file, { wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(), timeoutMs = 45000 } = {}) {
          const startedAt = now();
          const baseline = new Set(getComposerAttachments().map((card) => card.node));
          let input = document.querySelector('images-files-uploader input[type="file"]');
          if (!input) {
            const upload = iconButton("plus");
            if (!upload) throw new Error("Gemini upload control was not found.");
            upload.click();
            while (!input && now() - startedAt < Math.min(timeoutMs, 10000)) {
              input = document.querySelector('images-files-uploader input[type="file"]');
              if (!input) await wait(100);
            }
          }
          if (!input) throw new Error("Gemini upload file input was not found.");
          const transfer = new DataTransfer();
          transfer.items.add(file);
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          let readySince = null;
          while (now() - startedAt <= timeoutMs) {
            const cards = getComposerAttachments().filter((card) => !baseline.has(card.node));
            const matching = cards.filter((card) => file.type.startsWith("image/")
              ? card.kind === "image"
              : card.kind === "file" && card.filename.normalize("NFC") === file.name.normalize("NFC"));
            if (matching.length === 1 && cards.length === 1 && matching[0].ready) {
              if (readySince === null) readySince = now();
              if (now() - readySince >= 750) {
                return { method: "file_input", filenameConfirmed: !file.type.startsWith("image/"), readyConfirmed: true, evidence: matching[0].filename, totalElapsedMs: now() - startedAt };
              }
            } else {
              readySince = null;
            }
            if (now() - startedAt >= timeoutMs) break;
            await wait(100);
          }
          throw new Error(`Gemini did not confirm a ready attachment for "${file.name}".`);
        },
        getChatIdFromUrl(url) { return shared.normalizeGeminiConversationUrl(url)?.split("/").pop() || null; },
        historyLinkSelector: 'a[href^="/app/"], a[href^="https://gemini.google.com/app/"]',
        buildHistoryEntry(anchor) {
          const url = new URL(anchor.getAttribute("href"), "https://gemini.google.com").href;
          const chatUrl = shared.normalizeGeminiConversationUrl(url);
          return chatUrl ? { id: chatUrl.split("/").pop(), title: anchor.textContent.trim(), chatUrl } : null;
        },
        supportsFileUpload: true, supportsModelSelector: false, hasFormWrapper: false,
      };
    },
  };
})(globalThis);
