// 寒潮复核报告 CLI：node tools/cold-review.mjs <command>
// 命令：exposure | cold | compare | intervention | schedule | rebates | evidence | all
import { pathToFileURL } from 'node:url';
import {
  loadData, buildingExposure, coldSegments, compareBuildings,
  evaluateValveActions, buildSchedule, settlementReview, reviewAllDispositions,
  closedCaseReusability,
} from '../lib/index.mjs';

async function main() {
  const command = process.argv[2] ?? 'all';
  const folderArg = process.argv[3];
  const folder = folderArg ? pathToFileURL(folderArg.endsWith('/') ? folderArg : `${folderArg}/`) : undefined;
  const data = await loadData(folder);
  const buildingIds = data.buildings.map(b => b.building);

  const report = { generatedAt: new Date().toISOString(), command };

  switch (command) {
    case 'cold':
      report.coldSegments = Object.fromEntries(buildingIds.flatMap(id => [
        [`${id}/A`, coldSegments(data, id, 'A')],
        [`${id}/B`, coldSegments(data, id, 'B')],
      ]));
      break;
    case 'exposure':
      report.exposure = Object.fromEntries(buildingIds.flatMap(id => [
        [`${id}/A`, buildingExposure(data, id, 'A')],
        [`${id}/B`, buildingExposure(data, id, 'B')],
      ]));
      break;
    case 'compare':
      report.compareA = compareBuildings(data, buildingIds, 'A', '10:00');
      break;
    case 'intervention':
      report.valveActions = evaluateValveActions(data);
      break;
    case 'schedule':
      report.schedule = buildSchedule(data, { period: 'A' });
      break;
    case 'rebates':
      report.settlement = settlementReview(data);
      break;
    case 'evidence':
      report.dispositions = reviewAllDispositions(data);
      report.reusability = closedCaseReusability(data);
      break;
    case 'all':
      report.coldSegments = Object.fromEntries(buildingIds.map(id => [id, coldSegments(data, id, 'A')]));
      report.exposure = Object.fromEntries(buildingIds.map(id => [id, buildingExposure(data, id, 'A')]));
      report.compareA = compareBuildings(data, buildingIds, 'A', '10:00');
      report.valveActions = evaluateValveActions(data);
      report.schedule = buildSchedule(data, { period: 'A' });
      report.settlement = settlementReview(data);
      report.dispositions = reviewAllDispositions(data);
      report.reusability = closedCaseReusability(data);
      break;
    default:
      console.error(`未知命令 ${command}`);
      process.exitCode = 1;
      return;
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error(err.stack ?? err.message);
  process.exitCode = 1;
});
