# 1. Calendar Spread: "The Theta Farmer" (Iran Market)
The strategy in your screenshot ("Buy Far YES, Buy Near NO") is a **"Diagonal Spread"**. You are farming **Time Decay (Theta)**.

*   **The Setup**:
    *   **Long Leg**: Buy **Jun 30 YES** @ 63¢. (You bet it happens *eventually*).
    *   **Short Leg**: Buy **Jan 31 NO** @ 77¢. (You bet it won't happen *this week*).
*   **The Logic**:
    *   **Scenario A (Nothing happens by Jan 31)**:
        *   "Jan 31 NO" pays **$1.00**. Profit = 23¢.
        *   "Jun 30 YES" drops slightly (maybe to 60¢) because 1 week passed.
        *   **Net Result**: You pocket the short-term profit and "roll" into buying "Feb 28 NO". You are constantly "renting out" your risk.
    *   **Scenario B (Strike happens tomorrow)**:
        *   "Jan 31 NO" goes to **$0**. (Loss 77¢).
        *   "Jun 30 YES" goes to **$1.00**. (Profit 37¢).
        *   **Net Result**: Loss. This is **NOT risk-free**. It is a directional bet that "The market is overestimating the *immediate* risk."

*   **My Advice**: Look for **"Steep Yield Curves"**.
    *   If `Jan 31 YES` is 24% and `Feb 28 YES` is 45%, the market thinks there is a HUGE risk in February. If you think February will be quiet, that is your spread.

# 2. Spread Capture: Strengthening Your "London" Strategy
To make your "Discount Market Making" safer, I propose adding **"Auto-Chase" Logic**:
*   **Current Problem**: You buy NO @ 64¢, but YES runs away to 45¢. You are stuck.
*   **The Fix**: **"Inventory Balancing"**.
    *   If "NO" fills 5 shares, the bot *immediately* cancels the passive "YES" limit order and **Market Buys** "YES" (even if profit drops from 6% to 2%).
    *   **Why**: Better to take a small profit (or tiny loss) than to be left holding a naked bag. **Speed is your insurance.**

# 3. Group Arbitrage: Execution & Markets
*   **Target Markets**: **"2024 Presidential Election Nominees"**, **"Super Bowl Winner"**, **"Oscar Best Picture"**.
    *   Any market with >4 outcomes usually has pricing inefficiencies.
*   **Execution**:
    *   **Step 1**: Calculate `Sum(BestAsk)`.
    *   **Step 2**: If Sum < $0.98 (2% buffer), calculate `Min(Liquidity)` across all tokens.
    *   **Step 3**: Send **Parallel Buy Orders** for that minimum amount on ALL tokens.
    *   **Step 4**: (Crucial) Call the **CTF `merge` function** to convert your basket of tokens back into USDC instantly.

---

# 🚀 Build Plan: "The PolyTools Suite"

I will implement these three distinct modules into your dashboard:

### A. 🛡️ "Theta Farmer" Calculator (Calendar Spreads)
*   **Input**: A market slug (e.g., `us-strikes-iran`).
*   **Output**: A matrix showing the "Implied Probability" of each month and highlighting the "Steepest" months to sell.

### B. ⚡ "Auto-Chaser" Bot (Spread Capture)
*   **Feature**: A trading form where you set your "Buy Yes" and "Buy No" prices.
*   **Automation**: It monitors fills. If one side fills, it **automatically chases** the other side to close the loop.

### C. 🧩 Group Arb Scanner
*   **Feature**: Scans top markets for `Sum < 1`.
*   **Action**: Lists the "Basket Cost" (e.g., "Buy All Nominees for $0.95").

Shall I start by implementing **Module C (Group Arb Scanner)** first, as it's the safest/easiest place to start?