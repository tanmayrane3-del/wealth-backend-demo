require('dotenv').config();
const uri = process.env.SUPABASE_URI; const u = new URL(uri);
process.env.DB_HOST=u.hostname; process.env.DB_PORT=u.port||'5432';
process.env.DB_USER=u.username; process.env.DB_PASSWORD=u.password; process.env.DB_NAME=u.pathname.slice(1);
const pool = require('./db');

const userId = '678e54f5-55e4-4fd7-bbc9-581a016a0faa';

async function run() {
  const [ss, mfs, ms, phRow, liabRow] = await Promise.all([
    pool.query('SELECT COALESCE(SUM(sh.current_value),0)::float8 AS val, COALESCE(SUM(sh.current_value * COALESCE(ac.multiplier_1y,1.0)),0)::float8 AS p1, COALESCE(SUM(sh.current_value * COALESCE(ac.multiplier_3y,1.0)),0)::float8 AS p3, COALESCE(SUM(sh.current_value * COALESCE(ac.multiplier_5y,1.0)),0)::float8 AS p5 FROM stock_holdings sh LEFT JOIN asset_cagr ac ON ac.symbol=sh.tradingsymbol AND ac.asset_type=$2 WHERE sh.user_id=$1',[userId,'stock']),
    pool.query('SELECT COALESCE(SUM(COALESCE(mfh.current_value,mfh.amount_invested)),0)::float8 AS val, COALESCE(SUM(COALESCE(mfh.current_value,mfh.amount_invested) * COALESCE(ac.multiplier_1y,1.0)),0)::float8 AS p1, COALESCE(SUM(COALESCE(mfh.current_value,mfh.amount_invested) * COALESCE(ac.multiplier_3y,1.0)),0)::float8 AS p3, COALESCE(SUM(COALESCE(mfh.current_value,mfh.amount_invested) * COALESCE(ac.multiplier_5y,1.0)),0)::float8 AS p5 FROM mutual_fund_holdings mfh LEFT JOIN asset_cagr ac ON ac.symbol=mfh.isin AND ac.asset_type=$2 WHERE mfh.user_id=$1',[userId,'mf']),
    pool.query("SELECT COALESCE(SUM(mh.quantity_grams * CASE mh.purity WHEN '24k' THEN mr.gold_24k_per_gram WHEN '22k' THEN mr.gold_22k_per_gram ELSE mr.silver_per_gram END),0)::float8 AS val, COALESCE(SUM(mh.quantity_grams * CASE mh.purity WHEN '24k' THEN mr.gold_24k_per_gram WHEN '22k' THEN mr.gold_22k_per_gram ELSE mr.silver_per_gram END * COALESCE(ac.multiplier_1y,1.0)),0)::float8 AS p1, COALESCE(SUM(mh.quantity_grams * CASE mh.purity WHEN '24k' THEN mr.gold_24k_per_gram WHEN '22k' THEN mr.gold_22k_per_gram ELSE mr.silver_per_gram END * COALESCE(ac.multiplier_3y,1.0)),0)::float8 AS p3, COALESCE(SUM(mh.quantity_grams * CASE mh.purity WHEN '24k' THEN mr.gold_24k_per_gram WHEN '22k' THEN mr.gold_22k_per_gram ELSE mr.silver_per_gram END * COALESCE(ac.multiplier_5y,1.0)),0)::float8 AS p5 FROM metal_holdings mh CROSS JOIN (SELECT * FROM metal_rates_cache ORDER BY fetched_at DESC LIMIT 1) mr LEFT JOIN asset_cagr ac ON ac.asset_type='metal' AND ac.symbol=mh.metal_type::text WHERE mh.user_id=$1",[userId]),
    pool.query('SELECT asset_type, purchase_price::float8, purchase_date, current_market_value::float8 FROM physical_assets WHERE user_id=$1 AND is_active=true',[userId]),
    pool.query("SELECT outstanding_principal::float8, emi_amount::float8, tenure_months::int, start_date FROM liabilities WHERE user_id=$1 AND status='active' AND is_deleted=false",[userId]),
  ]);

  let physTotal=0;
  const today=new Date();
  for (const a of phRow.rows) {
    if (a.asset_type==='real_estate') physTotal+=parseFloat(a.current_market_value||a.purchase_price);
    else { const yrs=(today-new Date(a.purchase_date))/(365.25*24*60*60*1000); physTotal+=parseFloat(a.purchase_price)*Math.pow(0.85,yrs); }
  }

  const sv=parseFloat(ss.rows[0].val),sp1=parseFloat(ss.rows[0].p1),sp3=parseFloat(ss.rows[0].p3),sp5=parseFloat(ss.rows[0].p5);
  const mfv=parseFloat(mfs.rows[0].val),mp1=parseFloat(mfs.rows[0].p1),mp3=parseFloat(mfs.rows[0].p3),mp5=parseFloat(mfs.rows[0].p5);
  const mv=parseFloat(ms.rows[0].val),gp1=parseFloat(ms.rows[0].p1),gp3=parseFloat(ms.rows[0].p3),gp5=parseFloat(ms.rows[0].p5);
  const pp1=physTotal*Math.pow(0.85,1),pp3=physTotal*Math.pow(0.85,3),pp5=physTotal*Math.pow(0.85,5);

  const liab=liabRow.rows[0];
  const outstanding=parseFloat(liab.outstanding_principal),emi=parseFloat(liab.emi_amount);
  const startDate=new Date(liab.start_date),tenureMonths=liab.tenure_months;
  const endDate=new Date(startDate); endDate.setMonth(endDate.getMonth()+tenureMonths);
  const monthsRem=Math.max(0,Math.round((endDate-today)/(1000*60*60*24*30.44)));
  const ppm=monthsRem>0?outstanding/monthsRem:outstanding;
  const liab1y=Math.max(0,outstanding-12*ppm),liab3y=Math.max(0,outstanding-36*ppm),liab5y=Math.max(0,outstanding-60*ppm);

  const totalAssets=sv+mfv+mv+physTotal,netWorth=totalAssets-outstanding;
  const ta1=sp1+mp1+gp1+pp1,ta3=sp3+mp3+gp3+pp3,ta5=sp5+mp5+gp5+pp5;
  const nw1=ta1-liab1y,nw3=ta3-liab3y,nw5=ta5-liab5y;

  const f=v=>Math.round(v).toLocaleString('en-IN');
  const c=(p,b)=>((p/b-1)*100).toFixed(2)+'%';

  console.log('\nCAGR per class         1Y          3Y          5Y');
  console.log('Stocks             '+c(sp1,sv).padStart(9)+'   '+c(sp3,sv).padStart(9)+'   '+c(sp5,sv).padStart(9));
  console.log('MF                 '+c(mp1,mfv).padStart(9)+'   '+c(mp3,mfv).padStart(9)+'   '+c(mp5,mfv).padStart(9));
  console.log('Gold               '+c(gp1,mv).padStart(9)+'   '+c(gp3,mv).padStart(9)+'   '+c(gp5,mv).padStart(9));
  console.log('Physical (WDV)        -15.00%      -38.59%      -55.67%');
  console.log('\nAsset Projections      Now          1Y           3Y           5Y');
  console.log('Stocks          '+f(sv).padStart(10)+'  '+f(sp1).padStart(10)+'  '+f(sp3).padStart(10)+'  '+f(sp5).padStart(10));
  console.log('MF              '+f(mfv).padStart(10)+'  '+f(mp1).padStart(10)+'  '+f(mp3).padStart(10)+'  '+f(mp5).padStart(10));
  console.log('Gold            '+f(mv).padStart(10)+'  '+f(gp1).padStart(10)+'  '+f(gp3).padStart(10)+'  '+f(gp5).padStart(10));
  console.log('Physical        '+f(physTotal).padStart(10)+'  '+f(pp1).padStart(10)+'  '+f(pp3).padStart(10)+'  '+f(pp5).padStart(10));
  console.log('Total Assets    '+f(totalAssets).padStart(10)+'  '+f(ta1).padStart(10)+'  '+f(ta3).padStart(10)+'  '+f(ta5).padStart(10));
  console.log('\nLoan ('+monthsRem+' months remaining, ~'+f(ppm)+'/mo principal reduction)');
  console.log('Car Loan        '+f(outstanding).padStart(10)+'  '+f(liab1y).padStart(10)+'  '+f(liab3y).padStart(10)+'  '+f(liab5y).padStart(10));
  console.log('\nNet Worth       '+f(netWorth).padStart(10)+'  '+f(nw1).padStart(10)+'  '+f(nw3).padStart(10)+'  '+f(nw5).padStart(10));
  console.log('NW Growth                         '+c(nw1,netWorth).padStart(9)+'   '+c(nw3,netWorth).padStart(9)+'   '+c(nw5,netWorth).padStart(9));
  console.log('\n-- Current code returns (wrong):');
  console.log('projected_1y: '+f(netWorth*1.056)+' (netWorth x 1.056 -- ignores physical depreciation and loan paydown)');

  await pool.end();
}
run().catch(e => { console.error('ERR:',e.message); process.exit(1); });
