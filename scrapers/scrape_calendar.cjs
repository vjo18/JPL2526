const fs = require("fs");
const puppeteer = require("puppeteer");

(async () => {
  console.log("🚀 Starting calendar scrape...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  await page.goto(
    "https://www.rbfa.be/nl/competitie/CHP_123326/kalender",
    { waitUntil: "networkidle0" }
  );

  const matchData = await page.evaluate(async () => {
    const matchData = [];
    let currentDate = null;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function extractMatchData() {
      const elements = document.querySelectorAll(".game-item, .date");

      elements.forEach((element) => {
        if (element.classList.contains("date")) {
          currentDate = element.innerText.trim();
        } else if (element.classList.contains("game-item")) {
          const homeTeamElement = element.querySelector(
            ".team:first-child .team-name"
          );
          const awayTeamElement = element.querySelector(
            ".team.reverse .team-name"
          );
          const scoreElement = element.querySelector(".score");
          const matchLinkElement = element.querySelector(".team-score");
          const matchLink =
            matchLinkElement?.href || matchLinkElement?.parentNode?.href;

          const homeTeam = homeTeamElement?.innerText.trim() || null;
          const awayTeam = awayTeamElement?.innerText.trim() || null;
          const score = scoreElement?.innerText.trim() || null;

          let homeScore = null;
          let awayScore = null;
          if (score && score.includes("-")) {
            [homeScore, awayScore] = score.split("-").map((s) => s.trim());
          }

          const url = matchLink
            ? matchLink.startsWith("http")
              ? matchLink
              : window.location.origin + matchLink
            : null;

          if (homeTeam && awayTeam && url && currentDate) {
            matchData.push({
              url,
              date: currentDate,
              homeTeam,
              homeScore,
              awayTeam,
              awayScore,
            });
          }
        }
      });
    }

    const dropdown = document.querySelector("select");
    if (!dropdown) {
      return [];
    }

    const options = Array.from(dropdown.options);

    for (let i = 0; i < options.length; i++) {
      console.log(`➡️ Loading speeldag ${i + 1}/${options.length}...`);
      dropdown.selectedIndex = i;
      dropdown.dispatchEvent(new Event("change"));
      await sleep(2000);
      extractMatchData();
      console.log(`   ✔️ Speeldag ${i + 1} klaar, totaal: ${matchData.length} matchen`);
    }

    return matchData;
  });

  await browser.close();

  fs.writeFileSync(
    "data_raw/match_calendar.json",
    JSON.stringify(matchData, null, 2),
    "utf8"
  );

  console.log("💾 File saved: data_raw/match_calendar.json");
  console.log(`📊 Total matches scraped: ${matchData.length}`);
  console.log("✅ Calendar scraping complete.");
})();
