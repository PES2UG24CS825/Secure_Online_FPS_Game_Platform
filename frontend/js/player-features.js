const helpTopics = [
  {
    question: "I can't sign in or verify MFA",
    category: "account",
    answer: "Check that your email and password are correct, then enter the current six-digit code from your authenticator app. If another browser is signed in, log out there first. Use Forgot password if you need to reset your password."
  },
  {
    question: "My match or result is missing",
    category: "match",
    answer: "Return to the player page after the match finishes and refresh Matches. The latest ten completed matches are shown. A match review may take a short time if gameplay data is still being processed."
  },
  {
    question: "What does a security review mean?",
    category: "security",
    answer: "A review is an automated gameplay signal, not a final decision. Save a screenshot and send the match ID to support if you think the result is incorrect."
  },
  {
    question: "When do I earn coins and XP?",
    category: "rewards",
    answer: "Claim one daily sign-in reward per UTC day. A completed match also grants coins and XP. Use coins in the Cosmetic Store to buy profile badges."
  },
  {
    question: "How does the leaderboard work?",
    category: "match",
    answer: "The performance leaderboard compares completed matches using kills, K/D ratio, accuracy, and match consistency. XP and rewards do not affect the ranking."
  }
];

const featureEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

function renderFaq() {
  const root = document.getElementById("supportFaqList");
  if (!root) return;
  root.innerHTML = helpTopics.map((item, index) => `<button class="support-faq-button" type="button" data-faq-index="${index}">${featureEscape(item.question)}</button>`).join("");
}

function showHelpAnswer(topic) {
  if (!topic) return;
  const answer = document.getElementById("supportAnswer");
  const category = document.getElementById("supportCategory");
  const message = document.getElementById("supportMessage");
  if (answer) answer.textContent = topic.answer;
  if (category) category.value = topic.category;
  if (message && !message.value.trim()) message.value = `${topic.question}\n\n`;
}

function answerSupportQuestion(question) {
  const text = String(question || "").toLowerCase();
  if (/login|sign.?in|password|mfa|code|authenticator/.test(text)) return helpTopics[0];
  if (/match|result|game|session|missing/.test(text)) return helpTopics[1];
  if (/detect|security|risk|flag|ban|cheat/.test(text)) return helpTopics[2];
  if (/coin|xp|reward|store|purchase|badge/.test(text)) return helpTopics[3];
  if (/leader|rank|position|top player/.test(text)) return helpTopics[4];
  return {
    question: "Contact support",
    category: "other",
    answer: "I couldn't match that to a quick answer. Send a support message with the details and attach a screenshot if it helps; an admin can reply in Your support messages."
  };
}

async function compressSupportImage(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Choose a PNG, JPG, or WebP image.");
  if (file.size > 3 * 1024 * 1024) throw new Error("The proof image must be smaller than 3 MB.");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1400 / bitmap.width, 1400 / bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.82, 0.72, 0.62, 0.52]) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length < 870_000) return { name: file.name, mime_type: "image/jpeg", data_url: dataUrl };
  }
  throw new Error("This image is too large after compression. Choose a smaller image.");
}

async function loadSupportTickets() {
  const list = document.getElementById("supportTicketList");
  if (!list) return;
  try {
    const data = await api("/player/support/tickets");
    const tickets = data.tickets || [];
    list.innerHTML = tickets.map((ticket) => `<article class="support-ticket"><div class="support-ticket-head"><strong>${featureEscape(ticket.category)} · ${featureEscape(new Date(ticket.created_at).toLocaleString())}</strong><span class="badge ${ticket.status === "resolved" ? "good" : ticket.status === "answered" ? "warn" : "gray"}">${featureEscape(ticket.status)}</span></div><p>${featureEscape(ticket.message)}</p>${ticket.attachment_name ? `<small>Attachment: ${featureEscape(ticket.attachment_name)}</small>` : ""}${ticket.admin_reply ? `<div class="admin-reply"><strong>Admin reply</strong><p>${featureEscape(ticket.admin_reply)}</p></div>` : ""}</article>`).join("") || '<div class="empty">No support messages yet.</div>';
  } catch (error) {
    list.textContent = error.message || "Support messages could not be loaded.";
  }
}

let rewardsData;
let rewardRequestPending = false;
let rewardPage = 0;
let rewardLoadVersion = 0;
const rewardStore = document.getElementById("rewardStore");
const rewardStatus = document.getElementById("rewardStatus");
const rewardView = document.getElementById("rewardView");
const rewardFilter = document.getElementById("rewardFilter");
const dailyRewardButton = document.getElementById("claimDailyReward");
const rewardPrevious = document.getElementById("rewardPrevious");
const rewardNext = document.getElementById("rewardNext");

async function loadRewards() {
  if (!rewardStore) return;
  const version = ++rewardLoadVersion;
  rewardStatus.textContent = "Loading rewards…";
  try {
    const data = await api("/player/rewards");
    if (version !== rewardLoadVersion) return;
    rewardsData = data;
    const { coins, xp, level, daily_streak: streak } = rewardsData;
    document.getElementById("rewardCoins").textContent = Number(coins).toLocaleString();
    document.getElementById("rewardXp").textContent = Number(xp).toLocaleString() + " XP";
    document.getElementById("rewardLevel").textContent = "Level " + level;
    document.getElementById("rewardStreak").textContent = streak + (streak === 1 ? " day" : " days");
    const claimed = rewardsData.last_daily_login === new Date().toISOString().slice(0, 10);
    dailyRewardButton.disabled = claimed;
    document.getElementById("dailyRewardMessage").textContent = claimed ? "Today's reward claimed" : "25 coins and 25 XP per UTC day";
    const badge = document.getElementById("equippedRewardBadge");
    const equippedBadge = data.store.find(item => item.id === data.equipped_item && item.category !== "avatar" && item.category !== "banner");
    if (badge) {
      badge.hidden = !equippedBadge;
      badge.textContent = equippedBadge?.name || "";
    }
    renderRewards();
    renderMatchProcessing(rewardsData.match_processing || []);
    rewardStatus.textContent = "";
  } catch (error) {
    if (version === rewardLoadVersion) rewardStatus.textContent = error.message || "Rewards could not be loaded.";
  }
}

function renderMatchProcessing(rows) {
  const panel = document.getElementById("matchProcessingStatus");
  if (!panel) return;
  const completed = rows.filter(row => row.status === "completed");
  const average = matches => matches.reduce((sum, row) => sum + row.kills, 0) / matches.length;
  const scored = completed.filter(row => typeof row.kills === "number");
  const trend = scored.length >= 4
    ? `<p>Average kills: ${average(scored.slice(0, 2)).toFixed(1)} in your latest two matches and ${average(scored.slice(2, 4)).toFixed(1)} in the preceding two.</p>`
    : "";
  panel.innerHTML = trend + (rows.map(row => {
    const result = row.status === "completed" ? "Result saved" : row.status === "processing" ? "Processing" : "In progress";
    const analysis = row.analysis_status === "success" ? "Analysis complete" :
      row.analysis_status ? "Analysis: " + row.analysis_status : "Analysis status unavailable";
    const credit = { credited: "Rewards credited", pending: "Reward credit pending", failed: "Reward credit failed" }[row.reward_status] || "Reward status unavailable";
    return `<div class="list-row"><div><strong>${featureEscape(row.game || "Match")}</strong>
      <small>${featureEscape(row.ended_at ? new Date(row.ended_at).toLocaleString() : result)}</small></div>
      <span>${featureEscape([result, analysis, credit].join(" · "))}</span></div>`;
  }).join("") || '<p class="empty">No recent matches.</p>');
}

function renderRewards() {
  if (!rewardsData) return;
  const owned = new Set(rewardsData.owned_items || []);
  const view = rewardView.value;
  const filter = rewardFilter.value;
  const history = document.getElementById("rewardHistory");
  const pages = document.getElementById("rewardPages");
  pages.hidden = true;
  history.hidden = view !== "history";
  rewardStore.hidden = view === "history";
  document.getElementById("rewardFilterLabel").hidden = view === "history";
  if (view === "history") {
    history.innerHTML = rewardsData.transactions.map(row =>
      `<div class="list-row"><div><strong>${featureEscape(row.description)}</strong><small>${featureEscape(row.created_at ? new Date(row.created_at).toLocaleString() : "")}</small></div><span>${Number(row.coins)} coins · ${Number(row.xp)} XP</span></div>`
    ).join("") || '<p class="empty">No reward transactions yet.</p>';
    return;
  }
  const items = rewardsData.store.filter(item => {
    const hasItem = owned.has(item.id);
    if (view === "inventory" && !hasItem) return false;
    if (filter === "collection") return view === "inventory" || Boolean(item.pair);
    if (filter === "owned") return hasItem;
    if (filter === "affordable") return item.available && !hasItem && item.price <= rewardsData.coins;
    return filter === "all" || item.category === filter;
  }).sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  rewardPage = Math.min(rewardPage, totalPages - 1);
  pages.hidden = totalPages === 1;
  document.getElementById("rewardPageCount").textContent = `Page ${rewardPage + 1} of ${totalPages}`;
  rewardPrevious.disabled = rewardPage === 0;
  rewardNext.disabled = rewardPage >= totalPages - 1;
  rewardStore.innerHTML = items.slice(rewardPage * pageSize, (rewardPage + 1) * pageSize).map(item => {
    const hasItem = owned.has(item.id);
    const equipped = item.category === "avatar" || item.category === "banner"
      ? rewardsData.equipped_slots?.[item.category] === item.id : rewardsData.equipped_item === item.id;
    const canPreview = item.preview && item.artwork_ready;
    const affordable = item.price <= rewardsData.coins;
    const action = equipped ? "Equipped" : hasItem ? "Equip" : !item.available ?
      (item.artwork_ready ? "Unavailable" : "Artwork pending") : affordable ? "Buy" : "Insufficient coins";
    return `<article class="reward-item${equipped ? " equipped-card" : ""}" data-reward-category="${featureEscape(item.category || "badge")}">
      ${canPreview ? `<img class="reward-catalog-art" src="${featureEscape(item.preview)}" alt="" loading="lazy">` : ""}
      <div class="reward-item-body"><h3>${featureEscape(item.name)}</h3>
        <small>${featureEscape(item.category === "banner" ? "Background" : item.category || "Badge")} · ${Number(item.price)} coins${hasItem ? " · Owned" : ""}</small>
        <div class="reward-item-footer">
          ${canPreview ? `<button type="button" data-reward-action="preview" data-item-id="${featureEscape(item.id)}">Preview</button>` : ""}
          <button type="button" class="play-btn" data-reward-action="${hasItem ? "equip" : "buy"}" data-item-id="${featureEscape(item.id)}" ${equipped || (!hasItem && (!item.available || !affordable)) || !item.artwork_ready ? "disabled" : ""}>${action}</button>
        </div>
      </div></article>`;
  }).join("") || '<p class="empty">No items match this view.</p>';
}

for (const control of [rewardView, rewardFilter]) {
  control?.addEventListener("change", () => {
    rewardPage = 0;
    renderRewards();
  });
}
rewardPrevious?.addEventListener("click", () => {
  rewardPage = Math.max(0, rewardPage - 1);
  renderRewards();
});
rewardNext?.addEventListener("click", () => {
  rewardPage += 1;
  renderRewards();
});
document.getElementById("reloadRewards")?.addEventListener("click", loadRewards);
dailyRewardButton?.addEventListener("click", async () => {
  dailyRewardButton.disabled = true;
  try {
    const result = await api("/player/rewards/claim-daily", { method: "POST" });
    await loadRewards();
    rewardStatus.textContent = result.claimed ? "Daily reward credited." : result.message;
  } catch (error) {
    rewardStatus.textContent = error.message;
    dailyRewardButton.disabled = false;
  }
});

async function confirmRewardPurchase(item) {
  const dialog = document.getElementById("rewardPurchaseDialog");
  document.getElementById("rewardPurchaseDetails").textContent =
    `Buy ${item.name} for ${item.price} coins? Balance after purchase: ${rewardsData.coins - item.price} coins.`;
  const listeners = new AbortController();
  try {
    return await new Promise(resolve => {
      dialog.addEventListener("submit", event => {
        event.preventDefault();
        const confirmed = event.submitter?.value === "buy";
        dialog.close();
        resolve(confirmed);
      }, { signal: listeners.signal });
      dialog.addEventListener("cancel", event => {
        event.preventDefault();
        dialog.close();
        resolve(false);
      }, { signal: listeners.signal });
      dialog.showModal();
    });
  } finally {
    listeners.abort();
  }
}

async function loadLeaderboard() {
  const list = document.getElementById("leaderboardList");
  if (!list) return;
  try {
    const data = await api("/player/leaderboard");
    const current = data.current_player;
    if (current) {
      const rankedCount = Number(data.total_ranked || 0);
      const rankLabel = rankedCount > 0
        ? `#${current.rank} (Top ${Math.max(1, Math.ceil((current.rank / rankedCount) * 100))}%)`
        : `#${current.rank}`;
      document.getElementById("leaderboardRank").textContent = rankLabel;
      document.getElementById("leaderboardKills").textContent = Number(current.kills).toLocaleString();
      document.getElementById("leaderboardKd").textContent = Number(current.kd).toFixed(2);
      const overviewRank = document.getElementById("playerRank");
      if (overviewRank) overviewRank.textContent = rankLabel;
    }
    const renderPlayer = (player) => `
      <div class="leaderboard-row ${current?.id === player.id ? "current" : ""}">
        <div class="leaderboard-rank rank-${Number(player.rank)}">#${Number(player.rank)}</div>
        <div class="leaderboard-player">
          <img class="leaderboard-avatar" src="${featureEscape(player.avatar.src)}" alt="" width="34" height="34">
          <div><strong>${featureEscape(player.name)}</strong><small>${Number(player.accuracy).toFixed(1)}% accuracy · ${Number(player.matches)} matches</small></div>
        </div>
        <div class="leaderboard-metric"><strong>${Number(player.kills)}</strong><small>kills · ${Number(player.kd).toFixed(2)} K/D</small></div>
        <div class="leaderboard-metric"><strong>${Number(player.matches)}</strong><small>matches</small></div>
      </div>`;
    const ranked = data.leaderboard || [];
    const visible = current && !ranked.some(player => player.id === current.id) ? [...ranked, current] : ranked;
    list.innerHTML = visible.map(renderPlayer).join("") || '<div class="empty">Complete a match to enter the leaderboard.</div>';
    const overviewList = document.getElementById("overviewLeaderboardList");
    if (overviewList) overviewList.innerHTML = (data.leaderboard || []).slice(0, 5).map(renderPlayer).join("") || '<div class="empty">Complete a match to enter the leaderboard.</div>';
  } catch (error) {
    list.textContent = error.message || "Leaderboard could not be loaded.";
  }
}

document.getElementById("supportFaqList")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-faq-index]");
  if (button) showHelpAnswer(helpTopics[Number(button.dataset.faqIndex)]);
});
document.getElementById("supportQuestionForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = document.getElementById("supportQuestion");
  if (!question.value.trim()) return;
  showHelpAnswer(answerSupportQuestion(question.value));
});
document.getElementById("supportTicketForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("supportFormStatus");
  const button = document.getElementById("sendSupportTicket");
  button.disabled = true;
  status.textContent = "Sending…";
  try {
    const file = document.getElementById("supportAttachment").files?.[0];
    const attachment = file ? await compressSupportImage(file) : null;
    const payload = {
      category: document.getElementById("supportCategory").value,
      message: document.getElementById("supportMessage").value.trim(),
      attachment
    };
    const result = await api("/player/support/tickets", { method: "POST", body: JSON.stringify(payload) });
    status.textContent = result.message;
    document.getElementById("supportTicketForm").reset();
    await loadSupportTickets();
  } catch (error) {
    status.textContent = error.message || "Your message could not be sent.";
  } finally {
    button.disabled = false;
  }
});
document.getElementById("refreshSupportTickets")?.addEventListener("click", loadSupportTickets);
document.getElementById("refreshLeaderboard")?.addEventListener("click", loadLeaderboard);
const detectionModal = document.getElementById("detectionInfoModal");
const closeDetectionModal = () => { if (detectionModal?.open) detectionModal.close(); };
document.querySelectorAll("[data-detection-info]").forEach((button) => button.addEventListener("click", () => {
  if (detectionModal && !detectionModal.open) detectionModal.showModal();
}));
document.getElementById("detectionInfoClose")?.addEventListener("click", closeDetectionModal);
document.getElementById("detectionInfoDone")?.addEventListener("click", closeDetectionModal);
detectionModal?.addEventListener("click", (event) => { if (event.target === detectionModal) closeDetectionModal(); });
rewardStore?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-reward-action]");
  if (!button || rewardRequestPending) return;
  const item = rewardsData?.store.find(row => row.id === button.dataset.itemId);
  if (!item) return;
  const action = button.dataset.rewardAction;
  if (action === "preview") {
    const pair = rewardsData.store.filter(row => row.artwork_ready && (row.id === item.id || (item.pair && row.pair === item.pair)));
    const avatar = pair.find(row => row.category === "avatar");
    const background = pair.find(row => row.category === "banner");
    const panel = document.getElementById("rewardPreview");
    const portrait = document.getElementById("rewardPreviewAvatar");
    portrait.hidden = !avatar;
    if (avatar) portrait.src = avatar.preview;
    panel.style.backgroundImage = background ? 'linear-gradient(#10182755, #101827bb), url(' + JSON.stringify(background.preview) + ')' : "";
    document.getElementById("rewardPreviewName").textContent = item.name;
    panel.hidden = false;
    return;
  }
  rewardRequestPending = true;
  button.disabled = true;
  try {
    if (action === "buy" && !(await confirmRewardPurchase(item))) return;
    const result = await api("/player/rewards/" + (action === "buy" ? "purchase" : "equip"), {
      method: "POST",
      body: JSON.stringify({ item_id: item.id, ...(action === "buy" && { price: item.price }) })
    });
    if (result.avatar && typeof currentAppearance !== "undefined") {
      currentAppearance.avatar = result.avatar;
      currentAppearance.avatar_image = result.artwork || null;
      savedPortrait = result.avatar_portrait;
      loadLeaderboard();
    }
    if (result.banner && typeof currentAppearance !== "undefined") {
      currentAppearance.banner = result.banner;
      currentAppearance.banner_image = result.artwork || null;
    }
    if ((result.avatar || result.banner) && typeof renderPlayerAppearance === "function") renderPlayerAppearance();
    await loadRewards();
    rewardStatus.textContent = result.message;
  } catch (error) {
    rewardStatus.textContent = error.message || "The reward action failed.";
  } finally {
    button.disabled = false;
    rewardRequestPending = false;
  }
});

renderFaq();
loadRewards();
loadSupportTickets();
loadLeaderboard();

let supportPollTimer = null;
function startSupportPolling() {
  if (!supportPollTimer) {
    supportPollTimer = setInterval(() => {
      if (!document.hidden) {
        loadSupportTickets();
      }
    }, 30000);
  }
}
function stopSupportPolling() {
  if (supportPollTimer) {
    clearInterval(supportPollTimer);
    supportPollTimer = null;
  }
}
startSupportPolling();

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopSupportPolling();
  } else {
    loadSupportTickets();
    loadRewards();
    startSupportPolling();
  }
});
window.addEventListener("focus", () => {
  if (!document.hidden) {
    loadRewards();
    loadSupportTickets();
    loadLeaderboard();
  }
});
