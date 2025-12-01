// scrapers/scrape_player_data.js
// ESM-versie van je oude Playerdatav3-scraper

import puppeteer from "puppeteer";
import fs from "fs";

(async () => {
  console.log("🚀 Starting player data scrape...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(60000);

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // 1) Kalender inladen
  const raw = fs.readFileSync("data_raw/match_calendar.json", "utf8");
  const matches = JSON.parse(raw);

  // Alleen matchen met score
  const finishedMatches = matches.filter(
    (m) => m.homeScore !== null && m.awayScore !== null
  );

  const outPath = "data_raw/player_matchdata.csv";

  // 2) Bestaande file lezen om al gescrapete matchen te skippen
  const existingUrls = new Set();
  let headerWritten = false;

  if (fs.existsSync(outPath)) {
    const content = fs.readFileSync(outPath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > 0) {
      const header = lines[0].split(",");
      const idx = header.indexOf("Match URL");
      if (idx !== -1) {
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",");
          const url = cols[idx]?.replace(/^"|"$/g, "");
          if (url) existingUrls.add(url);
        }
      }
    }
    headerWritten = true;
  }

  const urlsToScrape = finishedMatches
    .map((m) => m.url)
    .filter((url) => url && !existingUrls.has(url));

  console.log(`📅 Gespeelde matchen: ${finishedMatches.length}`);
  console.log(`🆕 Nieuw te scrapen (players): ${urlsToScrape.length}`);

  // Vaste header zoals Playerdatav3 / build_player_stats.py verwachten
  const CSV_HEADER = [
    "Match URL",
    "Home Team",
    "Away Team",
    "Player Name",
    "Jersey Number",
    "Team",
    "Is Goalkeeper",
    "Is Captain",
    "Clean Sheet",
    "Match Result",
    "Starting Player",
    "Substituted In",
    "Substitution Minute (In)",
    "Substituted Out",
    "Substitution Minute (Out)",
    "Minutes Played",
    "Goals Scored",
    "Penalties Scored",
    "Own Goals Scored",
    "Yellow Cards",
    "Red Cards",
    "YellowRed Cards",
    "Card Minute",
    "Result P",
    "GoalDiff",
    "GoalFor",
    "GoalAgainst",
    "Result without P",
    "GoalDiff without P",
    "GoalWoFor",
    "GoalWoAgainst",
  ];

let index = 0;
let successCount = 0;
let noDataCount = 0;
let errorCount = 0;

  for (const url of urlsToScrape) {
    index++;
    try {
      console.log(`➡️ [${index}/${urlsToScrape.length}] Scraping ${url}...`);

      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 15000, // max 15 sec wachten
      });

      // Klik op "timeline"/"tijdslijn"/"verslag" zodat events geladen zijn
      await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll("a, button"));
        const tab = candidates.find((el) => {
          const t = el.textContent.trim().toLowerCase();
          return (
            t.includes("timeline") ||
            t.includes("tijdslijn") ||
            t.includes("verslag")
          );
        });
        if (tab) tab.click();
      });

      await sleep(300);

      // Alle Playerdatav3-logica rechtstreeks in page context
      const matchData = await page.evaluate(() => {
        function extractMatchData() {
          const matchUrl = window.location.href;
          const teamNames = document.querySelectorAll(".team-info h4");
          const homeTeam =
            teamNames[0]?.textContent.trim() ||
            "Home Team";
          const awayTeam =
            teamNames[1]?.textContent.trim() ||
            "Away Team";

          // Score uit header
          const scoreElement = document.querySelector(
            ".event-summery-info .score"
          );
          const scoreText = scoreElement?.textContent.trim() || "0 - 0";
          const [homeScore, awayScore] = scoreText
            .split(" - ")
            .map((x) => parseInt(x, 10) || 0);

          // Eindminuut van de match bepalen
          const getMatchEndMinute = () => {
            const timelineEvents = document.querySelectorAll(
              ".timeline-panel-inner .item"
            );
            let maxMinute = 90;
            timelineEvents.forEach((event) => {
              const badge =
                event.closest(".timeline-panel").previousElementSibling;
              const minuteText =
                badge?.textContent.trim().replace("‘", "") || null;
              const minute = minuteText ? parseInt(minuteText, 10) : null;
              if (minute && minute > maxMinute) {
                maxMinute = minute;
              }
            });
            return maxMinute;
          };

          const timelineEvents = document.querySelectorAll(
            ".timeline-panel-inner .item"
          );
          const playerData = [];
          let homePlayerCount = 0;
          let awayPlayerCount = 0;

          const calculatePlayerPerformance = (
            startMinute,
            endMinute,
            isHome
          ) => {
            let playerHomeScore = 0;
            let playerAwayScore = 0;

            timelineEvents.forEach((event) => {
              const badge =
                event.closest(".timeline-panel").previousElementSibling;
              const minuteText =
                badge?.textContent.trim().replace("‘", "") || null;
              const minute = minuteText ? parseInt(minuteText, 10) : null;

              const isGoal = event.querySelector(".item-icon.goal");
              const isOwnGoal = event.querySelector(".item-icon.owngoal");
              const isPenaltyGoal = event.querySelector(".item-icon.penalty");
              const isLeft = event
                .closest(".timeline-panel-inner")
                .classList.contains("left");

              if (
                (isGoal || isPenaltyGoal || isOwnGoal) &&
                minute &&
                minute >= startMinute &&
                minute <= endMinute
              ) {
                if (isLeft) {
                  playerHomeScore++;
                } else {
                  playerAwayScore++;
                }
              }
            });

            const playerTeamScore = isHome ? playerHomeScore : playerAwayScore;
            const opponentTeamScore = isHome
              ? playerAwayScore
              : playerHomeScore;

            return {
              goalFor: playerTeamScore,
              goalAgainst: opponentTeamScore,
              goalDiff: playerTeamScore - opponentTeamScore,
              result:
                playerTeamScore > opponentTeamScore
                  ? 1
                  : playerTeamScore === opponentTeamScore
                  ? 0.5
                  : 0,
            };
          };

          const calculatePerformanceWithoutPlayer = (
            startMinute,
            endMinute,
            isHome
          ) => {
            let homeScoreWithoutPlayer = 0;
            let awayScoreWithoutPlayer = 0;

            timelineEvents.forEach((event) => {
              const badge =
                event.closest(".timeline-panel").previousElementSibling;
              const minuteText =
                badge?.textContent.trim().replace("‘", "") || null;
              const minute = minuteText ? parseInt(minuteText, 10) : null;

              const isGoal = event.querySelector(".item-icon.goal");
              const isOwnGoal = event.querySelector(".item-icon.owngoal");
              const isPenaltyGoal = event.querySelector(".item-icon.penalty");
              const isLeft = event
                .closest(".timeline-panel-inner")
                .classList.contains("left");

              // Enkel doelpunten BUITEN de speelminuten van de speler
              if (
                (isGoal || isPenaltyGoal || isOwnGoal) &&
                (minute < startMinute || minute > endMinute)
              ) {
                if (isLeft) {
                  homeScoreWithoutPlayer++;
                } else {
                  awayScoreWithoutPlayer++;
                }
              }
            });

            const teamScoreWithoutPlayer = isHome
              ? homeScoreWithoutPlayer
              : awayScoreWithoutPlayer;
            const opponentScoreWithoutPlayer = isHome
              ? awayScoreWithoutPlayer
              : homeScoreWithoutPlayer;

            return {
              goalWoFor: teamScoreWithoutPlayer,
              goalWoAgainst: opponentScoreWithoutPlayer,
              goalDiffWithout:
                teamScoreWithoutPlayer - opponentScoreWithoutPlayer,
              resultWithout:
                teamScoreWithoutPlayer > opponentScoreWithoutPlayer
                  ? 1
                  : teamScoreWithoutPlayer === opponentScoreWithoutPlayer
                  ? 0.5
                  : 0,
            };
          };

          const parsePlayerInfo = (cell) => {
            const inElement = cell.querySelector(".extra-info .in");
            const outElement = cell.querySelector(".extra-info .out");
            const goalElements = cell.querySelectorAll(".extra-info .goal");
            const penaltyElements =
              cell.querySelectorAll(".extra-info .penalty");
            const ownGoalElements =
              cell.querySelectorAll(".extra-info .owngoal");
            const yellowCardElements =
              cell.querySelectorAll(".extra-info .yellow");
            const redCardElements = cell.querySelectorAll(".extra-info .red");
            const yellowRedElements =
              cell.querySelectorAll(".extra-info .yellowred");

            const goals = goalElements.length;
            const penalties = penaltyElements.length;
            const ownGoals = ownGoalElements.length;
            const yellowCards = yellowCardElements.length;
            const redCards = redCardElements.length;
            const yellowRedCards = yellowRedElements.length;

            const redCardMinute =
              redCardElements.length > 0
                ? parseInt(
                    redCardElements[0]
                      .textContent.replace("‘", "")
                      .trim(),
                    10
                  )
                : null;
            const yellowRedMinute =
              yellowRedElements.length > 0
                ? parseInt(
                    yellowRedElements[0]
                      .textContent.replace("‘", "")
                      .trim(),
                    10
                  )
                : null;

            const cardMinute = yellowRedMinute || redCardMinute || null;

            const substitutionMinuteIn = inElement
              ? parseInt(
                  inElement.textContent.replace("‘", "").trim(),
                  10
                )
              : null;
            const substitutionMinuteOut = outElement
              ? parseInt(
                  outElement.textContent.replace("‘", "").trim(),
                  10
                )
              : null;

            return {
              substitutionMinuteIn,
              substitutionMinuteOut,
              goals,
              penalties,
              ownGoals,
              yellowCards,
              redCards,
              yellowRedCards,
              cardMinute,
            };
          };

          const calculateMinutesPlayed = (subInfo, isStartingPlayer) => {
            if (isStartingPlayer) {
              if (subInfo.substitutionMinuteOut) {
                return subInfo.substitutionMinuteOut;
              }
              if (subInfo.cardMinute) {
                return subInfo.cardMinute;
              }
              return 90;
            } else {
              if (subInfo.substitutionMinuteIn) {
                return subInfo.substitutionMinuteOut
                  ? subInfo.substitutionMinuteOut -
                      subInfo.substitutionMinuteIn
                  : subInfo.cardMinute
                  ? subInfo.cardMinute - subInfo.substitutionMinuteIn
                  : 90 - subInfo.substitutionMinuteIn;
              }
              return 0;
            }
          };

          const rows = document.querySelectorAll(
            ".opstelling-tabel .table-scroll table tbody tr"
          );
          const matchEndMinute = getMatchEndMinute();

          rows.forEach((row) => {
            const cells = row.querySelectorAll("td");
            if (row.querySelector(".staff")) return;

            const processPlayer = (
              playerCell,
              jerseyNumber,
              isHome,
              team,
              isStartingPlayer
            ) => {
              const playerName =
                playerCell.querySelector(".name")?.textContent.trim();
              if (!playerName) return;

              const cleanName = playerName
                .replace("(GK)", "")
                .replace("(C)", "")
                .trim();
              const isGoalkeeper = playerName.includes("(GK)");
              const isCaptain = playerName.includes("(C)");

              const subInfo = parsePlayerInfo(playerCell);
              const minutesPlayed = calculateMinutesPlayed(
                subInfo,
                isStartingPlayer
              );

              const startMinute = isStartingPlayer
                ? 0
                : subInfo.substitutionMinuteIn || 0;
              const endMinute =
                isStartingPlayer &&
                !subInfo.substitutionMinuteOut &&
                !subInfo.cardMinute
                  ? matchEndMinute
                  : subInfo.substitutionMinuteOut ||
                    subInfo.cardMinute ||
                    matchEndMinute;

              const performance =
                minutesPlayed > 0
                  ? calculatePlayerPerformance(
                      startMinute,
                      endMinute,
                      isHome
                    )
                  : {
                      goalFor: null,
                      goalAgainst: null,
                      goalDiff: null,
                      result: null,
                    };

              const performanceWithout =
                minutesPlayed < 90
                  ? calculatePerformanceWithoutPlayer(
                      startMinute,
                      endMinute,
                      isHome
                    )
                  : {
                      goalWoFor: null,
                      goalWoAgainst: null,
                      goalDiffWithout: null,
                      resultWithout: null,
                    };

              const cleanSheet =
                isGoalkeeper &&
                minutesPlayed > 0 &&
                (isHome ? awayScore : homeScore) === 0;

              const matchResult = isHome
                ? homeScore > awayScore
                  ? "Win"
                  : homeScore < awayScore
                  ? "Loss"
                  : "Draw"
                : awayScore > homeScore
                ? "Win"
                : awayScore < homeScore
                ? "Loss"
                : "Draw";

              playerData.push({
                "Match URL": matchUrl,
                "Home Team": homeTeam,
                "Away Team": awayTeam,
                "Player Name": cleanName,
                "Jersey Number": jerseyNumber || "N/A",
                Team: team,
                "Is Goalkeeper": isGoalkeeper,
                "Is Captain": isCaptain,
                "Clean Sheet": cleanSheet,
                "Match Result": matchResult,
                "Starting Player": isStartingPlayer,
                "Substituted In": !!subInfo.substitutionMinuteIn,
                "Substitution Minute (In)":
                  subInfo.substitutionMinuteIn,
                "Substituted Out": !!subInfo.substitutionMinuteOut,
                "Substitution Minute (Out)":
                  subInfo.substitutionMinuteOut,
                "Minutes Played": minutesPlayed,
                "Goals Scored": subInfo.goals,
                "Penalties Scored": subInfo.penalties,
                "Own Goals Scored": subInfo.ownGoals,
                "Yellow Cards": subInfo.yellowCards,
                "Red Cards": subInfo.redCards,
                "YellowRed Cards": subInfo.yellowRedCards,
                "Card Minute": subInfo.cardMinute,
                "Result P": performance.result,
                GoalDiff: performance.goalDiff,
                GoalFor: performance.goalFor,
                GoalAgainst: performance.goalAgainst,
                "Result without P": performanceWithout.resultWithout,
                "GoalDiff without P":
                  performanceWithout.goalDiffWithout,
                GoalWoFor: performanceWithout.goalWoFor,
                GoalWoAgainst: performanceWithout.goalWoAgainst,
              });
            };

            if (cells.length === 2) {
              const leftCell = cells[0];
              const rightCell = cells[1];

              if (
                leftCell.classList.contains("digit") &&
                rightCell.classList.contains("player")
              ) {
                processPlayer(
                  rightCell,
                  leftCell.textContent.trim(),
                  true,
                  homeTeam,
                  homePlayerCount < 11
                );
                homePlayerCount++;
              } else if (
                rightCell.classList.contains("digit") &&
                leftCell.classList.contains("player")
              ) {
                processPlayer(
                  leftCell,
                  rightCell.textContent.trim(),
                  false,
                  awayTeam,
                  awayPlayerCount < 11
                );
                awayPlayerCount++;
              }
            } else if (cells.length === 4) {
              const homeJerseyNumber = cells[0]?.textContent.trim();
              const homePlayerCell = cells[1];
              const awayPlayerCell = cells[2];
              const awayJerseyNumber = cells[3]?.textContent.trim();

              processPlayer(
                homePlayerCell,
                homeJerseyNumber,
                true,
                homeTeam,
                homePlayerCount < 11
              );
              homePlayerCount++;

              processPlayer(
                awayPlayerCell,
                awayJerseyNumber,
                false,
                awayTeam,
                awayPlayerCount < 11
              );
              awayPlayerCount++;
            }
          });

          return playerData;
        }

        return extractMatchData();
      });

      if (!matchData || matchData.length === 0) {
        console.warn("   ⚠️ No player data found.");
        noDataCount += 1;
        continue;
      }


      console.log(`   ✔️ ${matchData.length} player rows.`);

      // CSV-rijen in vaste kolomvolgorde
      const rows = matchData.map((row) =>
        CSV_HEADER.map((key) => {
          const v = row[key];
          if (v === undefined || v === null) return "";
          if (typeof v === "string") {
            return '"' + v.replace(/"/g, '""') + '"';
          }
          return v;
        }).join(",")
      );

      if (!headerWritten) {
        fs.writeFileSync(
          outPath,
          CSV_HEADER.join(",") + "\n" + rows.join("\n")
        );
        headerWritten = true;
      } else {
        fs.appendFileSync(outPath, "\n" + rows.join("\n"));
      }

      successCount += 1;

    } catch (err) {
      console.error("   ❌ Error scraping " + url + ":", err.message);
      errorCount += 1;
    }


    await sleep(300);
  }

console.log("✅ Player scraping finished.");
console.log(`   ✔️ Successful: ${successCount}/${urlsToScrape.length}`);
console.log(`   ⚠️ No player data: ${noDataCount}`);
console.log(`   ❌ Errors: ${errorCount}`);

await browser.close();

})();
