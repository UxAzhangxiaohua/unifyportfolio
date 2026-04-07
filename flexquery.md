## IBKR Flex Query Setup for UnifyPortfolio

### Step 1 — Create the Flex Query (get Query ID)

1. **Performance & Reports → Flex Queries**
2. Click **`+`** next to "Activity Flex Queries"
3. Name it anything (e.g. `unifyportfolio`)
4. Enable these **3 sections**: `Account Information`, `Cash Report`, `Open Positions`
5. Configure each section's fields:

**Account Information:** `Account ID`, `Currency`

**Cash Report:** select option `Currency Breakout`, fields: `Account ID`, `Currency`, `Ending Cash`

**Open Positions:** select option `Summary`, fields: `Account ID`, `Currency`, `FXRateToBase`, `Asset Class`, `Symbol`, `Description`, `Quantity`, `Mark Price`, `Position Value`, `Position Value in Base`, `Unrealized P&L`

6. Delivery config: Format = `XML`, Period = `Last Business Day`
7. Save → click the **ⓘ blue info icon** next to the query → note your **6-digit Query ID**

---

### Step 2 — Get the Token

1. **Performance & Reports → Flex Queries**
2. On the right side, find **"Flex Web Service"** section
3. Enable it → click **Generate New Token**
4. Copy the long numeric token

---

### Step 3 — Add to `accounts.json`

```json
{
  "exchange": "ibkr",
  "label": "IBKR",
  "token": "YOUR_LONG_TOKEN_HERE",
  "queryId": "1461456"
}
```

---

### How it works

Your backend connector calls IBKR's URL with your token + query ID → gets a reference code → polls for the XML report → parses positions and cash balances → displays in dashboard.
