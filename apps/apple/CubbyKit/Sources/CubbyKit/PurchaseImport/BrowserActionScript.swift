import Foundation

/// Fixed DOM operations. Caller strings are JSON data, never JavaScript source or selectors.
/// References point to the observed live node, expire on DOM mutation, and are consumed before
/// an action. The retained HTML copies selection deliberately and never copies typed values.
/// Only visible password controls signal authentication; hidden login modals are omitted.
enum BrowserActionScript {
    static func observation(id: String) -> String {
        "(() => { const observationId = \(literal(id)); return " + observationBody + "})();"
    }

    static func perform(
        kind: String, observationId: String, ref: String, allowedHosts: [String],
        text: String = "", submit: Bool = false, optionRef: String? = nil
    ) -> String {
        let input: [String: Any] = [
            "kind": kind, "observationId": observationId, "ref": ref,
            "allowedHosts": allowedHosts, "text": text, "submit": submit,
            "optionRef": optionRef ?? "",
        ]
        let data = (try? JSONSerialization.data(withJSONObject: input, options: [.sortedKeys])) ?? Data()
        return "(() => { const action = \(String(decoding: data, as: UTF8.self)); return " + actionBody
            + "})();"
    }

    private static func literal(_ string: String) -> String {
        String(decoding: (try? JSONEncoder().encode(string)) ?? Data("\"\"".utf8), as: UTF8.self)
    }

    private static let observationBody = #"""
        (() => {
          const previous = window.__cubbyActions;
          if (previous) previous.observer.disconnect();
          const state = { id: observationId, url: location.href, nodes: new Map(), dirty: false };
          state.observer = new MutationObserver(() => { state.dirty = true; });
          state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
          window.__cubbyActions = state;
          const cleanLabel = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
          const navigationURL = node => {
            const raw = node.tagName === 'A' ? node.href : node.form?.action;
            if (!raw) return null;
            try {
              const url = new URL(raw, location.href);
              return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
            } catch { return null; }
          };
          const label = node => cleanLabel(
            node.getAttribute('aria-label') ||
            (node.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim() ||
            [...(node.labels || [])].map(item => item.textContent).join(' ').trim() ||
            node.getAttribute('alt') || node.getAttribute('title') ||
            (node.tagName === 'INPUT' ? ['submit', 'button', 'reset', 'image'].includes(node.type) ?
              node.getAttribute('value') || node.getAttribute('placeholder') : node.getAttribute('placeholder') :
              node.tagName === 'TEXTAREA' || node.isContentEditable ? '' : node.textContent)
          );
          const kind = node => {
            const role = node.getAttribute('role');
            if (node.tagName === 'OPTION') return 'option';
            if (node.tagName === 'SELECT') return 'select';
            if (node.tagName === 'TEXTAREA' || node.isContentEditable) return 'textbox';
            if (node.tagName === 'INPUT') {
              if (node.type === 'search') return 'searchbox';
              if (node.type === 'text') return 'textbox';
              if (['checkbox', 'radio'].includes(node.type)) return node.type;
              if (['submit', 'button', 'reset', 'image'].includes(node.type)) return 'button';
              return null;
            }
            if (node.tagName === 'A' && node.hasAttribute('href')) return 'link';
            if (['checkbox', 'radio', 'option'].includes(role)) return role;
            if (['BUTTON', 'SUMMARY'].includes(node.tagName) || ['button', 'tab', 'menuitem', 'link'].includes(role) ||
              node.hasAttribute('onclick') || node.tabIndex >= 0 || node.tagName === 'LABEL' && node.control)
              return 'button';
            return null;
          };
          const root = document.documentElement.cloneNode(true);
          const sourceNodes = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
          const clones = [root, ...root.querySelectorAll('*')];
          const actions = [];
          let actionsTruncated = false;
          sourceNodes.forEach((node, index) => {
            const copy = clones[index];
            [...copy.attributes].filter(attribute => attribute.name.startsWith('data-cubby-')).forEach(attribute => copy.removeAttribute(attribute.name));
            if (node.tagName === 'INPUT' && node.type === 'password' &&
              (node.closest('[hidden],[aria-hidden="true"]') || node.getClientRects().length === 0 ||
                ['hidden', 'collapse'].includes(getComputedStyle(node).visibility))) {
              copy.remove();
              return;
            }
            if (node.tagName === 'OPTION') {
              copy.toggleAttribute('selected', node.selected);
              copy.setAttribute('data-cubby-selected', String(node.selected));
            }
            if (node.tagName === 'INPUT' && ['checkbox', 'radio'].includes(node.type)) {
              copy.toggleAttribute('checked', node.checked);
              copy.setAttribute('data-cubby-checked', String(node.checked));
            }
            const controlKind = kind(node);
            if (!controlKind || node.closest('[hidden],[aria-hidden="true"],script,style,template,noscript')) return;
            if (controlKind !== 'option' && node.getClientRects().length === 0) return;
            if (actions.length >= 500) { actionsTruncated = true; return; }
            const ref = 'control-' + (actions.length + 1);
            const control = node.tagName === 'LABEL' ? node.control : node;
            const disabled = node.disabled === true || control?.disabled === true || node.getAttribute('aria-disabled') === 'true';
            const selected = node.tagName === 'OPTION' ? node.selected :
              node.hasAttribute('aria-selected') ? node.getAttribute('aria-selected') === 'true' :
              node.hasAttribute('aria-pressed') ? node.getAttribute('aria-pressed') === 'true' : null;
            const checked = control?.tagName === 'INPUT' && ['checkbox', 'radio'].includes(control.type) ? control.checked :
              node.hasAttribute('aria-checked') ? node.getAttribute('aria-checked') === 'true' : null;
            const parent = node.tagName === 'OPTION' ? node.closest('select') : null;
            const parentRef = parent ? [...state.nodes].find(([, item]) => item.node === parent)?.[0] || null : null;
            const description = { ref, kind: controlKind, label: label(node), disabled, selected, checked, parentRef, navigationURL: navigationURL(node) };
            state.nodes.set(ref, { node, kind: controlKind, label: description.label, selected, checked, disabled });
            copy.setAttribute('data-cubby-ref', ref);
            actions.push(description);
          });
          root.querySelectorAll('script:not([type="application/ld+json" i]),style,svg,noscript,template,iframe,link[rel~="stylesheet" i],link[rel~="preload" i]').forEach(node => node.remove());
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
          const comments = [];
          while (walker.nextNode()) comments.push(walker.currentNode);
          comments.forEach(node => node.remove());
          root.querySelectorAll('input:not([type="submit" i]):not([type="button" i]):not([type="reset" i]):not([type="image" i])').forEach(input => input.removeAttribute('value'));
          root.querySelectorAll('textarea,[contenteditable]').forEach(node => { node.textContent = ''; });
          return JSON.stringify({ observationId, url: location.href, title: document.title,
            readyState: document.readyState, actions, actionsTruncated, html: '<!doctype html>' + root.outerHTML });
        })();
        """#

    private static let actionBody = #"""
        (() => {
          const fail = code => JSON.stringify({ status: 'failed', code });
          const state = window.__cubbyActions;
          if (!state || state.id !== action.observationId || state.url !== location.href ||
            state.dirty || state.observer.takeRecords().length) return fail('stale_observation');
          for (const item of state.nodes.values()) {
            const control = item.node.tagName === 'LABEL' ? item.node.control : item.node;
            if (item.node.tagName === 'OPTION' && item.node.selected !== item.selected ||
              control?.tagName === 'INPUT' && ['checkbox', 'radio'].includes(control.type) && control.checked !== item.checked)
              return fail('stale_observation');
          }
          const item = state.nodes.get(action.ref);
          if (!item || !item.node.isConnected) return fail('stale_observation');
          const node = item.node;
          const allowed = raw => {
            try {
              const url = new URL(raw, location.href);
              return url.protocol === 'https:' && !url.username && !url.password &&
                action.allowedHosts.map(host => host.toLowerCase().replace(/^\.+|\.+$/g, '')).some(host =>
                  url.hostname === host || url.hostname.endsWith('.' + host));
            } catch { return false; }
          };
          if (!allowed(location.href)) return fail('disallowed_url');
          if (node.disabled || node.control?.disabled || node.getAttribute('aria-disabled') === 'true' ||
            node.closest('[hidden],[aria-hidden="true"]') || node.getClientRects().length === 0) return fail('action_unavailable');
          if (node.tagName === 'A' && !allowed(node.href)) return fail('disallowed_url');
          if ((action.kind === 'type' && action.submit || action.kind === 'click' &&
            ['submit', 'image'].includes(node.type)) && node.form && !allowed(node.form.action)) return fail('disallowed_url');
          if (action.kind === 'type' && !['textbox', 'searchbox'].includes(item.kind)) return fail('action_unavailable');
          if (action.kind === 'click' && !['link', 'button', 'checkbox', 'radio', 'option'].includes(item.kind)) return fail('action_unavailable');
          let option;
          if (action.kind === 'select') {
            option = state.nodes.get(action.optionRef)?.node;
            if (item.kind !== 'select' || !option || option.tagName !== 'OPTION' ||
              option.closest('select') !== node || option.disabled) return fail('action_unavailable');
          }
          if (action.kind === 'type' && action.submit && !node.form) return fail('action_unavailable');
          // Consumption precedes the side effect. Delivery repeats can never activate this ref again.
          state.observer.disconnect();
          window.__cubbyActions = null;
          window.addEventListener('beforeunload', () => { window.__cubbyLeaving = true; }, { once: true });
          node.scrollIntoView({ block: 'center', inline: 'nearest' });
          if (action.kind === 'click') {
            // Links remain in the owned tab, including target=_blank vendor navigation.
            if (node.tagName === 'A') node.target = '_self';
            node.click();
          } else if (action.kind === 'type') {
            node.focus();
            if (node.isContentEditable) node.textContent = action.text;
            else {
              const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, action.text);
            }
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
            if (action.submit) { node.form.target = '_self'; node.form.requestSubmit(); }
          } else if (action.kind === 'select') {
            node.selectedIndex = option.index;
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
          } else return fail('action_unavailable');
          return JSON.stringify({ status: 'completed' });
        })();
        """#
}
