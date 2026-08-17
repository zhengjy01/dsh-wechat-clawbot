/*!
 * dsh-client-wechat-ui — browser half of the WeChat bridge for DeepSeek
 * Harness. A floating ball (bottom-right) opens a panel that shows the
 * WeChat QR code, collects the on-phone verification code, manages sender
 * approvals, and logs recent messages. Talks directly to the local
 * wechat-gateway service (default http://127.0.0.1:51235).
 *
 * Zero-dependency bundle: pure DOM, no React, no RPC services.
 */
window.__ModuleLoader__.load({
	id: "dsh-client-wechat-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var GATEWAY = "http://127.0.0.1:51235";
		var GATEWAY_PORT = 51235;

		// ── tiny DOM helpers ─────────────────────────────────────────────
		function el(tag, className, text) {
			var node = document.createElement(tag);
			if (className) node.className = className;
			if (text !== undefined) node.textContent = text;
			return node;
		}
		function clear(node) {
			while (node.firstChild) node.removeChild(node.firstChild);
		}
		function fmtTime(ts) {
			var d = new Date(ts);
			return d.toTimeString().slice(0, 8);
		}
		function shortWxid(id) {
			return id.length > 24 ? id.slice(0, 10) + "…" + id.slice(-8) : id;
		}

		// ── state ────────────────────────────────────────────────────────
		var status = { phase: "idle", message: "", accountId: undefined, allowlist: [] };
		var pendingApprovals = new Map(); // wxid -> {text, ts}
		var panelOpen = false;
		var confirmingUnbind = false;
		var timers = [];
		var sseController = undefined;

		// ── styles ───────────────────────────────────────────────────────
		function injectStyles() {
			var tagId = "dsh-client-wechat-ui/styles";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]"))
				return;
			var style = document.createElement("style");
			style.dataset.plugin = "dsh-client-wechat-ui";
			style.dataset.pluginCss = tagId;
			style.textContent = [
				".dshwx-ball{position:fixed;right:24px;bottom:24px;width:56px;height:56px;border-radius:50%;",
				"background:#07C160;color:#fff;display:flex;align-items:center;justify-content:center;",
				"cursor:pointer;box-shadow:0 4px 16px rgba(7,193,96,.4);z-index:2147483000;",
				"border:none;outline:none;transition:transform .15s}",
				".dshwx-ball:hover{transform:scale(1.06)}",
".dshwx-ball.dshwx-inline{position:static;width:36px;height:36px;margin-left:8px;flex:none;box-shadow:none;display:inline-flex;vertical-align:middle}",
".dshwx-panel.dshwx-panel-left{right:auto;left:24px;bottom:92px}",

				".dshwx-panel{position:fixed;right:24px;bottom:92px;width:340px;max-height:520px;",
				"background:#fff;border:1px solid #e5e5e5;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.18);",
				"z-index:2147483001;display:flex;flex-direction:column;overflow:hidden;",
				"font:13px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2329}",
				".dshwx-head{display:flex;align-items:center;gap:8px;padding:12px 14px;",
				"border-bottom:1px solid #f0f0f0;background:#fafafa}",
				".dshwx-head .dot{width:10px;height:10px;border-radius:50%;background:#c9cdd4;flex:none}",
				".dshwx-head .dot.on{background:#07C160}.dshwx-head .dot.err{background:#fa5151}",
				".dshwx-head b{flex:1;font-size:14px}",
				".dshwx-head .x{cursor:pointer;border:none;background:none;font-size:16px;color:#8a9099;padding:0 4px}",
				".dshwx-body{padding:14px;overflow-y:auto;flex:1;min-height:0}",
				".dshwx-state{text-align:center;padding:6px 0 12px;color:#5a6068}",
				".dshwx-qr{width:200px;height:200px;margin:6px auto;display:block;border-radius:8px;",
				"image-rendering:pixelated;border:1px solid #eee}",
				".dshwx-btn{display:block;width:100%;padding:9px 0;margin:8px 0 4px;border:none;border-radius:8px;",
				"background:#07C160;color:#fff;font-size:14px;cursor:pointer}",
				".dshwx-btn.ghost{background:#fff;color:#07C160;border:1px solid #07C160}",
				".dshwx-btn.red{background:#fa5151}",
				".dshwx-input{display:block;width:100%;box-sizing:border-box;padding:8px 10px;margin:6px 0;",
				"border:1px solid #d8dce3;border-radius:8px;font-size:14px;outline:none}",
				".dshwx-model{border-top:1px solid #f0f0f0;margin-top:8px;padding-top:8px}",
				".dshwx-model .cap{font-size:12px;color:#5a6068;margin-bottom:6px;display:flex;align-items:center;gap:6px}",
				".dshwx-model .cap .cur{color:#07C160;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:right}",
				".dshwx-model label{display:block;font-size:12px;color:#8a9099;margin:6px 0 2px}",
				".dshwx-model select,.dshwx-model input{display:block;width:100%;box-sizing:border-box;padding:6px 8px;",
				"border:1px solid #d8dce3;border-radius:8px;font-size:13px;outline:none;background:#fff;color:#1f2329}",
				".dshwx-model .row2{display:flex;gap:8px}",
				".dshwx-model .row2>div{flex:1;min-width:0}",
				".dshwx-model .save{margin-top:8px;padding:7px 0;width:100%;border:none;border-radius:8px;",
				"background:#07C160;color:#fff;font-size:13px;cursor:pointer}",
				".dshwx-model .note{font-size:11px;color:#8a9099;margin-top:4px;min-height:14px}",
				".dshwx-foot{border-top:1px solid #f0f0f0;padding:8px 14px;text-align:center;font-size:12px;color:#b0b6bf}",
				".dshwx-foot a{color:#8a9099;text-decoration:none}",
				".dshwx-foot a:hover{color:#07C160}",
				".dshwx-approval{display:flex;align-items:center;gap:8px;padding:8px;margin:6px 0;",
				"border:1px solid #ffe2a8;background:#fff8e6;border-radius:8px}",
				".dshwx-approval .who{flex:1;min-width:0}",
				".dshwx-approval .preview{font-size:12px;color:#8a9099;word-break:break-all;max-height:34px;overflow:hidden}",
				".dshwx-approval button{border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px}",
				".dshwx-approval .ok{background:#07C160;color:#fff}",
				".dshwx-approval .no{background:#fff;color:#8a9099;border:1px solid #d8dce3}",
				".dshwx-hint{font-size:12px;color:#8a9099;text-align:center;padding:4px 0}",
			].join("");
			document.head.appendChild(style);
		}

		// ── gateway calls ────────────────────────────────────────────────
		function gateway(pathname, options) {
			return fetch(GATEWAY + pathname, options).then(function (res) {
				return res.json().catch(function () {
					return {};
				});
			});
		}
		function post(pathname, body) {
			return gateway(pathname, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body || {}),
			});
		}

		// ── UI construction ──────────────────────────────────────────────
		var ball, panel, head, dot, title, body, stateArea, qrImg, actionArea, approvalArea, modelArea, modelNote, foot;

		function build() {
			ball = el("button", "dshwx-ball");
			ball.id = "dshwx-ball";
			ball.title = "微信 · DSH";
			ball.innerHTML =
				'<svg width="30" height="30" viewBox="0 0 24 24" fill="none">' +
				'<path d="M9.5 4C5.4 4 2 6.9 2 10.5c0 2 1.1 3.8 2.8 5l-.7 2.2 2.5-1.3c.9.3 1.8.5 2.9.5" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>' +
				'<path d="M14.5 13.5c3.6 0 6.5-2.3 6.5-5.3S18.1 3 14.5 3 8 5.3 8 8.2s2.9 5.3 6.5 5.3z" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>' +
				'<path d="M20.5 18.5c1.4-.9 2.2-2.3 2.2-3.9 0-2.7-2.4-4.9-5.4-4.9s-5.4 2.2-5.4 4.9 2.4 4.9 5.4 4.9c.5 0 1-.1 1.5-.2l1.9.9-.4-1.5z" fill="#fff"/>' +
				"</svg>";
			panel = el("div", "dshwx-panel");
			panel.style.display = "none";
			head = el("div", "dshwx-head");
			dot = el("span", "dot");
			title = el("b", "", "微信 · DSH");
			var closeBtn = el("button", "x", "✕");
			closeBtn.addEventListener("click", togglePanel);
			head.append(dot, title, closeBtn);
			body = el("div", "dshwx-body");
			stateArea = el("div", "dshwx-state", "连接中…");
			actionArea = el("div", "dshwx-action");
			approvalArea = el("div", "dshwx-approvals");
			modelArea = el("div", "dshwx-model");
			body.append(stateArea, actionArea, approvalArea, modelArea);
			foot = el("div", "dshwx-foot");
			var credit = el("a", "", "github·LuBaiUwU");
			credit.href = "https://github.com/lubaiUwU/DSH-WeChatClawBot";
			credit.target = "_blank";
			credit.rel = "noopener";
			foot.appendChild(credit);
			panel.append(head, body, foot);

			mountBall();
			document.body.appendChild(panel);
		}

		var mountedInline = false;
		var mountTimer = undefined;

		// 优先把小球放进左侧边栏「设置」按钮右侧（settingsArea 容器）；
		// 侧边栏渲染是异步的，用 MutationObserver 等它出现，10 秒内没找到
		// 就回退到右下角悬浮。
		function mountBall() {
			var settingsArea = document.querySelector('[class*="settingsArea"]');
			if (settingsArea) {
				if (!mountedInline) {
					mountedInline = true;
					ball.classList.add("dshwx-inline");
					settingsArea.appendChild(ball);
					panel.classList.add("dshwx-panel-left");
				}
				return;
			}
			var observer = new MutationObserver(function () {
				var area = document.querySelector('[class*="settingsArea"]');
				if (area) {
					observer.disconnect();
					mountedInline = true;
					ball.classList.add("dshwx-inline");
					area.appendChild(ball);
					panel.classList.add("dshwx-panel-left");
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
			mountTimer = setTimeout(function () {
				observer.disconnect();
				if (!mountedInline) document.body.appendChild(ball);
			}, 10000);
		}

		function togglePanel() {
			panelOpen = !panelOpen;
			panel.style.display = panelOpen ? "flex" : "none";
			if (panelOpen) {
				render();
				loadModel(); // 打开时刷新模型区（此时尚未交互，重建无影响）
			}
		}

		// ── rendering ────────────────────────────────────────────────────
		function setDotClass(phase) {
			dot.className =
				"dot" + (phase === "logged_in" ? " on" : ["expired", "error", "logged_out"].includes(phase) ? " err" : "");
		}

		var lastPhase = "";
		var lastQr = undefined;
		var lastOpen = false;

		function render() {
			if (!panelOpen) return;
			var phase = status.phase;
			setDotClass(phase);
			title.textContent =
				phase === "logged_in"
					? "微信 · 已连接"
					: ["waiting_qrcode", "scanned", "need_verifycode"].includes(phase)
						? "微信 · 扫码登录"
						: "微信 · 未连接";

			// 状态文本总更新；操作区只在阶段/二维码变化时重建，
			// 否则正在输入的验证码、正在选择的模型会被轮询打断。
			clear(stateArea);
			stateArea.appendChild(el("div", "", status.message || phaseLabel(phase)));

			var phaseChanged =
				phase !== lastPhase || status.qrcodeDataUrl !== lastQr || lastOpen !== panelOpen;
			lastPhase = phase;
			lastQr = status.qrcodeDataUrl;
			lastOpen = panelOpen;
			if (!phaseChanged) {
				renderApprovals();
				return;
			}

			clear(actionArea);
			if (phase === "idle" || phase === "logged_out" || phase === "expired" || phase === "error") {
				var loginBtn = el("button", "dshwx-btn", "扫码登录微信");
				loginBtn.addEventListener("click", function () {
					post("/login", { force: true });
					stateArea.textContent = "正在获取二维码…";
				});
				actionArea.appendChild(loginBtn);
				actionArea.appendChild(
					el("div", "dshwx-hint", "登录后，微信消息将直接进入 DSH 会话，回复自动回传微信。"),
				);
			}
			if (phase === "waiting_qrcode" || phase === "scanned") {
				if (status.qrcodeDataUrl) {
					var img = el("img", "dshwx-qr");
					img.src = status.qrcodeDataUrl;
					img.alt = "微信登录二维码";
					actionArea.appendChild(img);
				}
				var refreshBtn = el("button", "dshwx-btn ghost", "刷新二维码");
				refreshBtn.addEventListener("click", function () {
					post("/login", { force: true });
				});
				actionArea.appendChild(refreshBtn);
				actionArea.appendChild(el("div", "dshwx-hint", "打开手机微信「扫一扫」，扫码后按提示操作"));
			}
			if (phase === "need_verifycode") {
				var codeInput = el("input", "dshwx-input");
				codeInput.type = "text";
				codeInput.inputMode = "numeric";
				codeInput.placeholder = "手机微信上显示的验证码";
				var submitBtn = el("button", "dshwx-btn", "提交验证码");
				submitBtn.addEventListener("click", function () {
					post("/verifycode", { code: codeInput.value.trim() });
				});
				codeInput.addEventListener("keydown", function (e) {
					if (e.key === "Enter") submitBtn.click();
				});
				actionArea.append(codeInput, submitBtn);
			}
			if (phase === "logged_in") {
				var account = el("div", "dshwx-hint", "账号 " + shortWxid(status.accountId || "?"));
				actionArea.appendChild(account);
				actionArea.appendChild(
					el("div", "dshwx-hint", "微信消息进入独立的微信对话区，不会显示在 GUI 会话中。"),
				);
				var chatRow = el("div", "dshwx-hint", "");
				var chatInfo = el("span", "", "当前对话：第 " + (wechatIndex || "1") + " 个");
				var newChatBtn = el("button", "dshwx-btn ghost", "新对话");
				newChatBtn.style.cssText = "display:inline-block;width:auto;padding:4px 12px;margin:6px 0 0;font-size:12px";
				newChatBtn.addEventListener("click", function () {
					modelFetch("/wechat/new", { method: "POST" })
						.then(function (res) {
							if (res.ok && res.sessionIndex) {
								wechatIndex = res.sessionIndex;
								chatInfo.textContent = "当前对话：第 " + res.sessionIndex + " 个";
							}
						});
				});
				chatRow.appendChild(chatInfo);
				chatRow.appendChild(document.createTextNode("　"));
				chatRow.appendChild(newChatBtn);
				actionArea.appendChild(chatRow);
				var unbindBtn = el("button", "dshwx-btn red", "解绑");
				unbindBtn.addEventListener("click", function () {
					if (confirmingUnbind) {
						confirmingUnbind = false;
						unbindBtn.textContent = "解绑中…";
						post("/logout")
							.then(function () { return post("/login", {}); })
							.catch(function () { unbindBtn.textContent = "解绑"; });
					} else {
						confirmingUnbind = true;
						unbindBtn.textContent = "确认解绑？再点一次";
						setTimeout(function () {
							confirmingUnbind = false;
							if (unbindBtn.parentNode) unbindBtn.textContent = "解绑";
						}, 5000);
					}
				});
				actionArea.appendChild(unbindBtn);
			}

			renderApprovals();
		}

		function phaseLabel(phase) {
			return {
				idle: "未连接",
				logged_out: "未连接（检测到已保存的登录，请点击登录刷新）",
				expired: "二维码已过期",
				error: "出错了",
				logged_in: "已连接微信",
			}[phase] || phase;
		}

		function renderApprovals() {
			clear(approvalArea);
			if (pendingApprovals.size === 0) return;
			pendingApprovals.forEach(function (item, wxid) {
				var row = el("div", "dshwx-approval");
				var who = el("div", "who", "新联系人 " + shortWxid(wxid));
				if (item.text) who.appendChild(el("div", "preview", item.text));
				var ok = el("button", "ok", "批准");
				var no = el("button", "no", "忽略");
				ok.addEventListener("click", function () {
					post("/allow", { wxid: wxid, allow: true }).then(function () {
						pendingApprovals.delete(wxid);
						render();
					});
				});
				no.addEventListener("click", function () {
					post("/allow", { wxid: wxid, allow: false }).then(function () {
						pendingApprovals.delete(wxid);
						render();
					});
				});
				row.append(who, ok, no);
				approvalArea.appendChild(row);
			});
		}

		var MODEL_API = "http://127.0.0.1:51236";
		var modelData = { current: null, available: [], efforts: [] };
		var wechatIndex = 1;
		var modelEditing = false;

		function modelFetch(pathname, options) {
			return fetch(MODEL_API + pathname, options).then(function (res) {
				return res.json().catch(function () {
					return {};
				});
			});
		}

		function loadModel() {
			modelFetch("/wechat/status").then(function (data) {
				if (data.sessionIndex) wechatIndex = data.sessionIndex;
				if (panelOpen) render();
			}).catch(function () {});
			return modelFetch("/model")
				.then(function (data) {
					modelData = data;
					if (panelOpen) buildModelUI();
				})
				.catch(function () {
					modelData = { current: null, available: [], efforts: [] };
				});
		}

		function buildModelUI() {
			if (!modelArea) return;
			clear(modelArea);
			var cap = el("div", "cap", "ClawBot 使用模型");
			var cur = modelData.current && modelData.current.provider
				? modelData.current.provider + " / " + modelData.current.model +
					(modelData.current.reasoningEffort ? " · " + modelData.current.reasoningEffort : "")
				: "跟随默认";
			cap.appendChild(el("span", "cur", cur));
			modelArea.appendChild(cap);

			var quickLabel = el("label", "", "快捷选择（已配密钥的模型）");
			var quick = el("select", "");
			var opt = el("option", "", "跟随 DSH 默认");
			opt.value = "";
			quick.appendChild(opt);
			var current = modelData.current && modelData.current.provider ? modelData.current : null;
			(modelData.available || []).forEach(function (m) {
				var o = el("option", "", m.provider + " / " + m.model + (m.name ? "（" + m.name + "）" : "") + (m.hasKey ? "" : "（未配置密钥）"));
				o.value = JSON.stringify({ provider: m.provider, model: m.model });
				quick.appendChild(o);
			});
			var customOpt = el("option", "", "自定义填写…");
			customOpt.value = "__custom__";
			quick.appendChild(customOpt);
			// 预选当前配置：匹配快捷列表选中该项；否则选「自定义」并回填输入框
			var customSelected = false;
			if (current) {
				var matched = (modelData.available || []).some(function (m) {
					return m.provider === current.provider && m.model === current.model;
				});
				if (matched) quick.value = JSON.stringify({ provider: current.provider, model: current.model });
				else customSelected = true;
			} else {
				quick.value = "";
			}
			var quickRow = el("div", "row2", "");
			var quickWrap = el("div", "");
			quickWrap.append(quickLabel, quick);
			quickRow.appendChild(quickWrap);
			modelArea.appendChild(quickRow);

			var customWrap = el("div", "", "");
			customWrap.style.display = customSelected ? "block" : "none";
			var pLabel = el("label", "", "Provider");
			var pInput = el("input", "");
			pInput.placeholder = "deepseek-official";
			pInput.value = current && customSelected ? current.provider : "";
			var mLabel = el("label", "", "模型");
			var mInput = el("input", "");
			mInput.placeholder = "deepseek-v4-flash";
			mInput.value = current && customSelected ? current.model : "";
			customWrap.append(pLabel, pInput, mLabel, mInput);
			modelArea.appendChild(customWrap);

			var effortLabel = el("label", "", "思考强度");
			var effort = el("select", "");
			var defaultEffort = el("option", "", "跟随默认");
			defaultEffort.value = "";
			effort.appendChild(defaultEffort);
			(modelData.efforts || ["off", "high", "max"]).forEach(function (e) {
				var o = el("option", "", e === "high" ? "high（默认）" : e);
				o.value = e;
				effort.appendChild(o);
			});
			// 预选当前思考强度
			effort.value = current && current.reasoningEffort ? current.reasoningEffort : "";
			var effortWrap = el("div", "");
			effortWrap.append(effortLabel, effort);
			modelArea.appendChild(effortWrap);

			var note = el("div", "note", "");
			modelNote = note;
			var save = el("button", "save", "保存模型配置");
			save.addEventListener("click", function () {
				var selected;
				if (quick.value === "") selected = { provider: "", model: "" }; // 跟随默认 = 清除配置
				else if (quick.value === "__custom__") {
					selected = { provider: pInput.value.trim(), model: mInput.value.trim() };
				} else {
					selected = JSON.parse(quick.value);
				}
				if (!selected.provider && !selected.model) {
					note.textContent = "保存后将恢复跟随 DSH 默认…";
					selected = { provider: "", model: "" };
				} else if (!selected.provider || !selected.model) {
					note.textContent = "请选择或填写 Provider 与模型";
					return;
				}
				var body = { provider: selected.provider, model: selected.model };
				if (effort.value !== "") body.reasoningEffort = effort.value;
				modelFetch("/model", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}).then(function (res) {
					if (res.ok) {
						modelData.current = body; // 本地立即生效，重建展示新模型
						if (panelOpen) buildModelUI();
						if (modelNote) modelNote.textContent = "已保存，下一个微信回合生效";
					} else {
						note.textContent = "保存失败：" + (res.error || "未知错误");
					}
				});
			});
			modelArea.append(save, note);

			quick.addEventListener("change", function () {
				customWrap.style.display = quick.value === "__custom__" ? "block" : "none";
			});
		}

		// ── data loop ────────────────────────────────────────────────────
		function pollStatus() {
			gateway("/status")
				.then(function (data) {
					if (data.phase) status = data;
					if (panelOpen) render();
				})
				.catch(function () {
					status.phase = "error";
					status.message = "无法连接网关（" + GATEWAY + "）——请确认已重启 DeepSeek Harness";
					if (panelOpen) render();
				});
			timers.push(setTimeout(pollStatus, ["waiting_qrcode", "scanned", "need_verifycode"].includes(status.phase) ? 1500 : 4000));
		}

		function connectSse() {
			if (sseController) return;
			sseController = new AbortController();
			fetch(GATEWAY + "/events", { signal: sseController.signal })
				.then(function (res) {
					if (!res.ok) throw new Error("HTTP " + res.status);
					var reader = res.body.getReader();
					var decoder = new TextDecoder();
					var buffer = "";
					function pump() {
						return reader.read().then(function (result) {
							if (result.done) throw new Error("stream closed");
							buffer += decoder.decode(result.value, { stream: true });
							var idx;
							while ((idx = buffer.indexOf("\n\n")) !== -1) {
								var block = buffer.slice(0, idx);
								buffer = buffer.slice(idx + 2);
								var event = "message";
								var data = "";
								block.split("\n").forEach(function (line) {
									if (line.startsWith("event:")) event = line.slice(6).trim();
									else if (line.startsWith("data:")) data += line.slice(5).trim();
								});
								if (data) handleSse(event, JSON.parse(data));
							}
							return pump();
						});
					}
					return pump();
				})
				.catch(function () {
					/* gateway down — poll loop reports it */
				})
				.finally(function () {
					sseController = undefined;
					timers.push(setTimeout(connectSse, 3000));
				});
		}

		function handleSse(event, data) {
			if (event === "message" || event === "send/result") {
				// 消息回执仅用于状态刷新，不再展示日志
			} else if (event === "approval") {
				pendingApprovals.set(data.wxid, { text: data.text || "", ts: data.ts || Date.now() });
				if (panelOpen) renderApprovals();
			} else if (event === "login/state") {
				status.phase = data.phase;
				status.message = data.message || "";
				status.accountId = data.accountId;
				if (panelOpen) render();
			}
		}

		// ── plugin entry ─────────────────────────────────────────────────
		exports.inject = [];
		exports.apply = function apply() {
			if (document.getElementById("dshwx-ball")) return; // already mounted
			injectStyles();
			build();
			ball.addEventListener("click", togglePanel);
			pollStatus();
			connectSse();
			loadModel();
		};

		return module.exports;
	}
});
