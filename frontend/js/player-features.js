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

async function loadRewards() {
  const store = document.getElementById("rewardStore");
  if (!store) return;
  try {
    const daily = await api("/player/rewards/claim-daily", { method: "POST" });
    const data = await api("/player/rewards");
    document.getElementById("rewardCoins").textContent = Number(data.coins || 0).toLocaleString();
    document.getElementById("rewardXp").textContent = `${Number(data.xp || 0).toLocaleString()} XP`;
    document.getElementById("rewardLevel").textContent = `Level ${data.level || 1} · ${Number(data.xp || 0) % 250}/250 XP to next level`;
    document.getElementById("rewardStreak").textContent = `${Number(data.daily_streak || 0)} day${Number(data.daily_streak) === 1 ? "" : "s"}`;
    const dailyMessage = document.getElementById("dailyRewardMessage");
    if (dailyMessage) dailyMessage.textContent = daily.claimed ? "Daily bonus claimed: +25 coins · +25 XP" : "Daily bonus: 25 coins + 25 XP";

    const owned = new Set(data.owned_items || []);
    const equippedBadge = document.getElementById("equippedRewardBadge");
    const equippedItem = (data.store || []).find((item) => item.id === data.equipped_item);
    if (equippedBadge) {
      equippedBadge.hidden = !equippedItem;
      equippedBadge.textContent = equippedItem ? `${equippedItem.icon} ${equippedItem.name}` : "";
    }
    store.innerHTML = (data.store || []).map((item) => {
      const hasItem = owned.has(item.id);
      const equipped = data.equipped_item === item.id;
      const label = equipped ? "Equipped" : hasItem ? "Equip badge" : `Buy · ${item.price} coins`;
      const action = hasItem ? "equip" : "buy";
      return `<article class="reward-item"><strong aria-hidden="true">${featureEscape(item.icon)}</strong><h3>${featureEscape(item.name)}</h3><p>${featureEscape(item.description)}</p><span class="reward-price">${hasItem ? "Owned" : `${item.price} coins`}</span><button class="play-btn" type="button" data-reward-action="${action}" data-item-id="${featureEscape(item.id)}" ${equipped ? "disabled" : ""}>${label}</button></article>`;
    }).join("") || '<div class="empty">No store items are available.</div>';

    const history = document.getElementById("rewardHistory");
    if (history) history.innerHTML = (data.transactions || []).map((item) => `<div class="list-row"><div><strong>${featureEscape(item.description)}</strong><small>${featureEscape(item.created_at ? new Date(item.created_at).toLocaleString() : "")}</small></div><span class="badge good">${item.coins > 0 ? `+${item.coins} coins` : item.coins < 0 ? `${item.coins} coins` : `+${item.xp} XP`}</span></div>`).join("") || '<div class="empty">Daily and match rewards will appear here.</div>';
  } catch (error) {
    store.textContent = error.message || "Rewards could not be loaded.";
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
      const rankLabel = rankedCount > 0 && rankedCount < 20
        ? `Top ${Math.max(1, Math.ceil((current.rank / rankedCount) * 100))}%`
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
        <div class="leaderboard-player"><strong>${featureEscape(player.name)}</strong><small>${Number(player.accuracy).toFixed(1)}% accuracy · ${Number(player.matches)} matches</small></div>
        <div class="leaderboard-metric"><strong>${Number(player.kills)}</strong><small>kills · ${Number(player.kd).toFixed(2)} K/D</small></div>
        <div class="leaderboard-metric"><strong>${Number(player.matches)}</strong><small>matches</small></div>
      </div>`;
    list.innerHTML = (data.leaderboard || []).map(renderPlayer).join("") || '<div class="empty">Complete a match to enter the leaderboard.</div>';
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
const closeDetectionModal = () => { if (detectionModal) detectionModal.hidden = true; };
document.querySelectorAll("[data-detection-info]").forEach((button) => button.addEventListener("click", () => {
  if (detectionModal) detectionModal.hidden = false;
}));
document.getElementById("detectionInfoClose")?.addEventListener("click", closeDetectionModal);
document.getElementById("detectionInfoDone")?.addEventListener("click", closeDetectionModal);
detectionModal?.addEventListener("click", (event) => { if (event.target === detectionModal) closeDetectionModal(); });
document.getElementById("rewardStore")?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-reward-action]");
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/player/rewards/${button.dataset.rewardAction === "buy" ? "purchase" : "equip"}`, {
      method: "POST",
      body: JSON.stringify({ item_id: button.dataset.itemId })
    });
    await loadRewards();
  } catch (error) {
    button.disabled = false;
    window.showAppAlert(error.message, { title: "Reward store", tone: "warning" });
  }
});

renderFaq();
loadRewards();
loadSupportTickets();
loadLeaderboard();
setInterval(loadSupportTickets, 30000);
window.addEventListener("focus", () => { loadRewards(); loadSupportTickets(); loadLeaderboard(); });
