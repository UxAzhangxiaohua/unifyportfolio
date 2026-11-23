// Command mt5snap logs in to one MT5 account (investor / read-only
// password), prints a JSON snapshot of the account and its open
// positions to stdout, and exits. It never trades.
//
// Credentials are read as JSON from stdin so the password never shows
// up in the process list:
//
//	{"login": 12345678, "password": "...", "server": "Exness-MT5Real8", "host": ""}
//
// Every run is a fresh login on purpose: on some broker clusters a
// long-lived session keeps serving the positions as of login (see the
// mtapi DESIGN notes), while a fresh login always reads live values.
//
// All monetary output is converted to USD (usdRate = USD per 1 unit of
// the account currency). Position notional is computed from contract
// size × volume × price and converted to USD from the symbol name's
// currencies; symbols whose quote currency cannot be identified (most
// indices) are assumed to be USD-quoted.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/voorz/mtapi"
)

type input struct {
	Login    json.RawMessage `json:"login"` // number or string
	Password string          `json:"password"`
	Server   string          `json:"server"`
	Host     string          `json:"host"`
}

type position struct {
	Ticket       int64   `json:"ticket"`
	Symbol       string  `json:"symbol"`
	Side         string  `json:"side"` // long | short
	Volume       float64 `json:"volume"`
	OpenPrice    float64 `json:"openPrice"`
	Price        float64 `json:"price"` // 0 when no quote arrived
	ContractSize float64 `json:"contractSize"`
	ProfitUSD    float64 `json:"profitUsd"` // profit + swap + commission
	NotionalUSD  float64 `json:"notionalUsd"`
	Magic        int64   `json:"magic"`
	SL           float64 `json:"sl"` // 0 = not set
	TP           float64 `json:"tp"`
	// Price PnL if closed at TP / SL (USD, excl. swap & commission); null when unset or unconvertible
	TPPnlUSD *float64 `json:"tpPnlUsd"`
	SLPnlUSD *float64 `json:"slPnlUsd"`
}

type output struct {
	Login           int64      `json:"login"`
	Server          string     `json:"server"`
	Group           string     `json:"group"`
	Currency        string     `json:"currency"`
	UsdRate         float64    `json:"usdRate"`
	Leverage        int        `json:"leverage"`
	BalanceUSD      float64    `json:"balanceUsd"`
	CreditUSD       float64    `json:"creditUsd"`
	EquityUSD       float64    `json:"equityUsd"`
	MarginUSD       float64    `json:"marginUsd"`
	MarginEstimated bool       `json:"marginEstimated"`
	Positions       []position `json:"positions"`
	Warnings        []string   `json:"warnings"`
}

var currencies = map[string]bool{
	"USD": true, "EUR": true, "GBP": true, "JPY": true, "CHF": true, "AUD": true, "NZD": true, "CAD": true,
	"SGD": true, "HKD": true, "CNH": true, "SEK": true, "NOK": true, "DKK": true, "PLN": true, "ZAR": true,
	"MXN": true, "TRY": true, "HUF": true, "CZK": true, "ILS": true, "THB": true, "INR": true,
	"XAU": true, "XAG": true, "XPT": true, "XPD": true, "BTC": true, "ETH": true, "USDT": true,
}

// splitSymbol returns (base, quote, suffix) for currency-pair style
// names such as EURUSD, XAUUSDm, GBPJPY.r; base is "" for non-pairs
// (US30, USOIL), and quote is "" when it cannot be identified.
func splitSymbol(sym string) (base, quote, suffix string) {
	core := sym
	if i := strings.IndexAny(core, ".#+-_"); i > 0 {
		core, suffix = core[:i], core[i:]
	}
	// A trailing lowercase broker suffix (XAUUSDm, EURUSDc).
	if n := len(core); n > 6 && core[n-1] >= 'a' && core[n-1] <= 'z' {
		suffix = core[n-1:] + suffix
		core = core[:n-1]
	}
	up := strings.ToUpper(core)
	if len(up) == 6 && currencies[up[:3]] && currencies[up[3:]] {
		return up[:3], up[3:], suffix
	}
	if len(up) > 3 && currencies[up[len(up)-3:]] {
		return "", up[len(up)-3:], suffix
	}
	return "", "", suffix
}

func fail(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"error": msg})
	os.Exit(1)
}

func main() {
	var in input
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		fail("read credentials: %v", err)
	}
	login, err := strconv.ParseUint(strings.Trim(string(in.Login), `" `), 10, 64)
	if err != nil || login == 0 {
		fail("invalid login")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()

	client, err := mtapi.Dial(ctx, mtapi.Config{
		Login: login, Password: in.Password, Server: in.Server, Host: in.Host,
		Timeout: 15 * time.Second,
	})
	if err != nil {
		fail("login: %v", err)
	}
	defer client.Close()

	acct, err := client.Account(ctx)
	if err != nil {
		fail("account: %v", err)
	}
	// First read subscribes position symbols and fetches their contract sizes.
	raw, err := client.Positions(ctx)
	if err != nil {
		fail("positions: %v", err)
	}

	out := output{
		Login: acct.Login, Server: acct.Server, Group: acct.Group, Currency: acct.Currency,
		Leverage: acct.Leverage, Positions: []position{}, Warnings: []string{},
	}
	if out.Server == "" {
		out.Server = in.Server
	}

	// Quote symbols needed: position symbols plus FX legs for converting
	// non-USD currencies (quote currencies and the account currency).
	suffixes := map[string]bool{"": true}
	need := map[string]bool{}
	for _, p := range raw {
		need[p.Symbol] = true
		_, _, sfx := splitSymbol(p.Symbol)
		suffixes[sfx] = true
	}
	fxCcy := map[string]bool{}
	acctCcy := strings.ToUpper(acct.Currency)
	if acctCcy != "USD" && acctCcy != "USC" && acctCcy != "USDT" {
		fxCcy[acctCcy] = true
	}
	for _, p := range raw {
		b, q, _ := splitSymbol(p.Symbol)
		_ = b
		if q != "" && q != "USD" {
			fxCcy[q] = true
		}
	}
	// fxSym[ccy] = (symbol, inverted): ccyUSD direct, or USDccy inverted.
	type fxLeg struct {
		sym      string
		inverted bool
	}
	fxSym := map[string]fxLeg{}
	for ccy := range fxCcy {
	search:
		for sfx := range suffixes {
			for _, cand := range []fxLeg{{ccy + "USD" + sfx, false}, {"USD" + ccy + sfx, true}} {
				if _, ok := client.Symbol(cand.sym); ok {
					fxSym[ccy] = cand
					need[cand.sym] = true
					break search
				}
			}
		}
	}
	if len(need) > 0 {
		names := make([]string, 0, len(need))
		for n := range need {
			names = append(names, n)
		}
		qctx, qcancel := context.WithTimeout(ctx, 8*time.Second)
		_, _ = client.SubscribeQuotes(qctx, names) // best effort
		qcancel()
		// Second read recomputes profits from the live quotes.
		if live, err := client.Positions(ctx); err == nil {
			raw = live
		}
	}

	mid := func(sym string) float64 {
		q, ok := client.Quote(sym)
		if !ok || q.Bid <= 0 || q.Ask <= 0 {
			return 0
		}
		return (q.Bid + q.Ask) / 2
	}
	// toUSD returns USD per 1 unit of ccy, 0 when unknown.
	toUSD := func(ccy string) float64 {
		switch ccy {
		case "USD", "USDT":
			return 1
		case "USC":
			return 0.01
		}
		leg, ok := fxSym[ccy]
		if !ok {
			return 0
		}
		m := mid(leg.sym)
		if m <= 0 {
			return 0
		}
		if leg.inverted {
			return 1 / m
		}
		return m
	}

	rate := toUSD(acctCcy)
	if rate == 0 {
		rate = 1
		out.Warnings = append(out.Warnings, fmt.Sprintf("no USD rate for account currency %s; values shown unconverted", acct.Currency))
	}
	out.UsdRate = rate
	out.BalanceUSD = acct.Balance * rate
	out.CreditUSD = acct.Credit * rate
	out.EquityUSD = acct.Equity * rate
	if out.EquityUSD == 0 && len(raw) == 0 {
		out.EquityUSD = out.BalanceUSD + out.CreditUSD
	}

	notionalSum := 0.0
	for _, p := range raw {
		pos := position{
			Ticket: p.Ticket, Symbol: p.Symbol, Volume: p.Volume, OpenPrice: p.Price,
			ProfitUSD: (p.Profit + p.Swap + p.Commission) * rate, Magic: p.Magic, Side: "long",
			SL: p.SL, TP: p.TP,
		}
		if p.Type == mtapi.TypeSell {
			pos.Side = "short"
		}
		if q, ok := client.Quote(p.Symbol); ok {
			if pos.Side == "long" {
				pos.Price = q.Bid
			} else {
				pos.Price = q.Ask
			}
		}
		sym, _ := client.Symbol(p.Symbol)
		pos.ContractSize = sym.ContractSize
		price := pos.Price
		if price <= 0 {
			price = p.Price
		}
		if pos.ContractSize > 0 && price > 0 {
			units := p.Volume * pos.ContractSize
			base, quote, _ := splitSymbol(p.Symbol)
			switch {
			case base == "USD":
				pos.NotionalUSD = units
			case quote == "":
				pos.NotionalUSD = units * price // assume USD-quoted (indices, oil)
			default:
				if r := toUSD(quote); r > 0 {
					pos.NotionalUSD = units * price * r
				} else {
					out.Warnings = append(out.Warnings, fmt.Sprintf("%s: no USD rate for %s, notional unknown", p.Symbol, quote))
				}
			}
		} else {
			out.Warnings = append(out.Warnings, fmt.Sprintf("%s: contract size or price unavailable, notional unknown", p.Symbol))
		}
		// PnL at a target price: Δprice × units, in the quote currency (USD when unknown)
		if pos.ContractSize > 0 {
			_, quote, _ := splitSymbol(p.Symbol)
			qr := 1.0
			if quote != "" {
				qr = toUSD(quote)
			}
			sign := 1.0
			if pos.Side == "short" {
				sign = -1
			}
			at := func(target float64) *float64 {
				if target <= 0 || qr <= 0 {
					return nil
				}
				v := math.Round(sign*(target-p.Price)*p.Volume*pos.ContractSize*qr*100) / 100
				return &v
			}
			pos.TPPnlUSD, pos.SLPnlUSD = at(p.TP), at(p.SL)
		}
		notionalSum += pos.NotionalUSD
		out.Positions = append(out.Positions, pos)
	}

	out.MarginUSD = acct.Margin * rate
	// Some clusters leave the record's margin at zero: estimate it the
	// way plain leverage-based margining does (notional / leverage).
	if out.MarginUSD == 0 && notionalSum > 0 && acct.Leverage > 0 {
		out.MarginUSD = notionalSum / float64(acct.Leverage)
		out.MarginEstimated = true
	}
	for i := range out.Positions {
		out.Positions[i].NotionalUSD = math.Round(out.Positions[i].NotionalUSD*100) / 100
	}

	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fail("encode: %v", err)
	}
}
