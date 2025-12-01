import puppeteer from "puppeteer";
import fs from "fs";

async function main() {
  console.log("🚀 Single match events scrape...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(30000);

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  const url = "https://www.rbfa.be/nl/wedstrijd/7124483";
  const outPath = "data_raw/match_events_single.csv";

  console.log("➡️ Scraping " + url + "...");

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // Klik op "timeline" / "tijdslijn" / "verslag"
  await page.evaluate(function () {
    var nodes = Array.prototype.slice.call(
      document.querySelectorAll("a, button")
    );
    var tab = nodes.find(function (el) {
      var t = el.textContent.trim().toLowerCase();
      return (
        t.indexOf("timeline") !== -1 ||
        t.indexOf("tijdslijn") !== -1 ||
        t.indexOf("verslag") !== -1
      );
    });
    if (tab) {
      tab.click();
    }
  });

  await sleep(1500);

  // Probeersel om "meer/toon alles" open te klikken
  for (var i = 0; i < 3; i += 1) {
    await page.evaluate(function () {
      var buttons = Array.prototype.slice
        .call(document.querySelectorAll("a, button"))
        .filter(function (el) {
          var t = el.textContent.trim().toLowerCase();
          return (
            t.indexOf("meer") !== -1 ||
            t.indexOf("toon meer") !== -1 ||
            t.indexOf("toon alles") !== -1 ||
            t.indexOf("more") !== -1 ||
            t.indexOf("show all") !== -1
          );
        });
      buttons.forEach(function (btn) {
        try {
          btn.click();
        } catch (e) {}
      });
    });
    await sleep(700);
  }

  // Een paar keer scrollen om lazy-load te triggeren
  for (var step = 0; step < 4; step += 1) {
    await page.evaluate(function (s, total) {
      var h = document.body.scrollHeight || 2000;
      var y = Math.round((h * (s + 1)) / (total + 1));
      window.scrollTo(0, y);
    }, step, 4);
    await sleep(400);
  }

  await page.evaluate(function () {
    window.scrollTo(0, 0);
  });
  await sleep(500);

  try {
    await page.waitForSelector(".timeline-panel-inner .item", {
      timeout: 8000,
    });
  } catch (e) {
    console.log("⚠️ Geen timeline-items gevonden.");
  }

  var domCount = await page.$$eval(
    ".timeline-panel-inner .item",
    function (els) {
      return els.length;
    }
  );
  console.log("ℹ️ Timeline-items in DOM: " + domCount);

  // Evenementen extracteren
  var eventData = await page.evaluate(function () {
    function extractMatchEvents() {
      var matchUrl = window.location.href;

      var teamNames = document.querySelectorAll(".team-info h4");
      var homeTeam =
        (teamNames[0] && teamNames[0].textContent.trim().replace(/'/g, "")) ||
        "Home Team";
      var awayTeam =
        (teamNames[1] && teamNames[1].textContent.trim().replace(/'/g, "")) ||
        "Away Team";

      var timelineEvents = Array.prototype.slice.call(
        document.querySelectorAll(".timeline-panel-inner .item")
      );

      timelineEvents = timelineEvents.sort(function (a, b) {
        var panelA = a.closest(".timeline-panel");
        var panelB = b.closest(".timeline-panel");
        var badgeA = panelA ? panelA.previousElementSibling : null;
        var badgeB = panelB ? panelB.previousElementSibling : null;

        var minuteA = badgeA
          ? badgeA.textContent.trim().replace("‘", "")
          : null;
        var minuteB = badgeB
          ? badgeB.textContent.trim().replace("‘", "")
          : null;

        var mA = minuteA ? parseInt(minuteA, 10) : 0;
        var mB = minuteB ? parseInt(minuteB, 10) : 0;
        return mA - mB;
      });

      var eventsOut = [];
      var homeScore = 0;
      var awayScore = 0;

      function getTeamInfo(item) {
        var panelInner = item.closest(".timeline-panel-inner");
        var isLeft = panelInner && panelInner.classList.contains("left");
        return {
          team: isLeft ? homeTeam : awayTeam,
          isHome: Boolean(isLeft),
        };
      }

      timelineEvents.forEach(function (item) {
        var info = getTeamInfo(item);
        var team = info.team;
        var isHome = info.isHome;

        var eventType = "";
        if (item.querySelector(".item-icon.goal")) {
          eventType = "Goal";
        } else if (item.querySelector(".item-icon.penalty")) {
          eventType = "Penalty";
        } else if (item.querySelector(".item-icon.yellow")) {
          eventType = "Yellow Card";
        } else if (item.querySelector(".item-icon.red")) {
          eventType = "Red Card";
        } else if (item.querySelector(".item-icon.yellowred")) {
          eventType = "Yellow-Red Card";
        } else if (item.querySelector(".item-icon.in")) {
          eventType = "Substitute In";
        } else if (item.querySelector(".item-icon.out")) {
          eventType = "Substitute Out";
        } else if (item.querySelector(".item-icon.owngoal")) {
          eventType = "Own Goal";
        }

        var firstNameEl = item.querySelector(".name-wrapper .firstname");
        var lastNameEl = item.querySelector(".name-wrapper .lastname");
        var firstName = firstNameEl
          ? firstNameEl.textContent.trim()
          : "";
        var lastName = lastNameEl
          ? lastNameEl.textContent.trim()
          : "";
        var playerNameRaw = (firstName + " " + lastName).trim();
        var playerName = playerNameRaw.replace(/'/g, "");

        var panel = item.closest(".timeline-panel");
        var badge = panel ? panel.previousElementSibling : null;
        var minuteText = badge
          ? badge.textContent.trim().replace("‘", "")
          : null;
        var minute = minuteText ? parseInt(minuteText, 10) : null;

        if (
          eventType === "Goal" ||
          eventType === "Penalty" ||
          eventType === "Own Goal"
        ) {
          if (isHome) {
            homeScore += 1;
          } else {
            awayScore += 1;
          }
        }

        if (eventType) {
          var opponent = isHome ? awayTeam : homeTeam;
          eventsOut.push({
            matchurl: matchUrl,
            home_team: homeTeam,
            away_team: awayTeam,
            event: eventType,
            player_name: playerName,
            team: team,
            minute: minute,
            is_home: isHome ? 1 : 0,
            home_team_goals: homeScore,
            away_team_goals: awayScore,
            team_against: opponent,
          });
        }
      });

      return eventsOut;
    }

    return extractMatchEvents();
  });

  console.log("✔️ Events gevonden: " + eventData.length);

  if (!eventData || eventData.length === 0) {
    console.log("⚠️ Geen events om te bewaren.");
    await browser.close();
    return;
  }

  var header = [
    "matchurl",
    "home_team",
    "away_team",
    "event",
    "player_name",
    "team",
    "minute",
    "is_home",
    "home_team_goals",
    "away_team_goals",
    "team against",
  ];

  var lines = [];
  lines.push(header.join(","));

  eventData.forEach(function (row) {
    var values = header.map(function (key) {
      var value;
      if (key === "team against") {
        value = row.team_against;
      } else {
        value = row[key];
      }
      if (value === undefined || value === null) {
        return "";
      }
      if (typeof value === "string") {
        return "\"" + value.replace(/"/g, "\"\"") + "\"";
      }
      return value;
    });
    lines.push(values.join(","));
  });

  fs.writeFileSync(outPath, lines.join("\n"));
  console.log("💾 Saved to " + outPath);

  await browser.close();
  console.log("✅ Done.");
}

main().catch(function (err) {
  console.error("Fatal error:", err);
  process.exit(1);
});
