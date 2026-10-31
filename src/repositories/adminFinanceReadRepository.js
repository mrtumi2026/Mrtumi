'use strict';

const { env } = require('../config/env');
const { getPool, createQueryClient } = require('../db/mysqlPool');
const { paisaToBdtString } = require('../utils/money');
const { ValidationError } = require('../utils/errors');

function clientFor(pool) {
  if (env.db.client !== 'mysql' && !pool) throw new ValidationError('MySQL finance reads require the MySQL database.');
  return createQueryClient(pool || getPool());
}
const amount = (value) => paisaToBdtString(Number(value || 0), { fixedDecimals:true });

async function listFundTransactions({pool=null}={}) {
  const client=clientFor(pool);
  const rows=await client.queryAll(`SELECT id,account_name,tx_type AS type,amount_paisa,note,tx_date,created_at
    FROM fund_transactions ORDER BY tx_date DESC,id DESC`);
  return rows.map((row)=>({...row,amount:amount(row.amount_paisa)}));
}

async function getFundSummary({pool=null}={}) {
  const client=clientFor(pool);
  const row=await client.queryOne(`SELECT COALESCE(SUM(CASE WHEN tx_type='credit' THEN amount_paisa ELSE 0 END),0) AS credits_paisa,
    COALESCE(SUM(CASE WHEN tx_type='debit' THEN amount_paisa ELSE 0 END),0) AS debits_paisa FROM fund_transactions`);
  const credits=Number(row?.credits_paisa||0),debits=Number(row?.debits_paisa||0);
  return {credits:amount(credits),debits:amount(debits),balance:amount(credits-debits)};
}

async function listExpenses({pool=null}={}) {
  const client=clientFor(pool);
  const rows=await client.queryAll(`SELECT id,title,category,amount_paisa,note,expense_date,created_at
    FROM expenses ORDER BY expense_date DESC,id DESC`);
  return rows.map((row)=>({...row,amount:amount(row.amount_paisa)}));
}

async function listPaymentRecords({status='all',search='',limit=250}={}, {pool=null}={}) {
  const client=clientFor(pool);
  const where=[];const params=[];
  const normalizedStatus=String(status||'all').trim().toLowerCase();
  if(normalizedStatus!=='all') {
    if(!/^[a-z_]{2,32}$/.test(normalizedStatus))throw new ValidationError('Invalid payment status filter.');
    where.push('op.status=?');params.push(normalizedStatus);
  }
  const needle=String(search||'').trim().slice(0,120);
  if(needle) {
    where.push('(o.invoice_no LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ? OR op.provider_trx_id LIKE ?)');
    params.push(...Array(4).fill(`%${needle}%`));
  }
  const rowLimit=Number(limit);
  if(!Number.isSafeInteger(rowLimit)||rowLimit<1||rowLimit>500)throw new ValidationError('Payment record limit must be between 1 and 500.');
  const clause=where.length?`WHERE ${where.join(' AND ')}`:'';
  const rows=await client.queryAll(`SELECT op.id,op.order_id,o.invoice_no,o.customer_name,o.customer_phone,
    op.gateway_code,op.provider_trx_id,op.sender_number,op.amount_paisa,op.payment_purpose,op.status,
    op.verified_at,op.created_at FROM order_payments op JOIN orders o ON o.id=op.order_id
    ${clause} ORDER BY op.created_at DESC,op.id DESC LIMIT ?`,[...params,rowLimit]);
  return rows.map((row)=>({...row,amount:amount(row.amount_paisa)}));
}

async function getReport(typeInput,{pool=null}={}) {
  const client=clientFor(pool);
  const type=String(typeInput||'profitloss').toLowerCase();
  if(!['orders','purchases','expenses','stock','profitloss','profit-loss'].includes(type))throw new ValidationError('Unsupported finance report type.');
  const [sales,purchases,expenses,stockValue]=await Promise.all([
    client.queryOne(`SELECT COALESCE(SUM(CASE WHEN order_status<>'cancelled' THEN total_paisa ELSE 0 END),0) AS total_sales_paisa,
      COALESCE(SUM(CASE WHEN order_status='completed' THEN total_paisa ELSE 0 END),0) AS completed_sales_paisa FROM orders`),
    client.queryOne('SELECT COALESCE(SUM(total_cost_paisa),0) AS total_purchases_paisa FROM purchases'),
    client.queryOne('SELECT COALESCE(SUM(amount_paisa),0) AS total_expenses_paisa FROM expenses'),
    client.queryOne(`SELECT COALESCE(SUM((CASE WHEN vendor_id IS NULL THEN stock_on_hand ELSE vendor_stock_on_hand END)*cost_price_paisa),0) AS stock_cost_paisa,
      COALESCE(SUM((CASE WHEN vendor_id IS NULL THEN stock_on_hand ELSE vendor_stock_on_hand END)*sale_price_paisa),0) AS stock_retail_paisa
      FROM products WHERE is_archived=0`),
  ]);
  const summary={
    totalSales:amount(sales.total_sales_paisa),completedSales:amount(sales.completed_sales_paisa),
    totalPurchases:amount(purchases.total_purchases_paisa),totalExpenses:amount(expenses.total_expenses_paisa),
    stockCostVal:amount(stockValue.stock_cost_paisa),stockRetailVal:amount(stockValue.stock_retail_paisa),
  };
  let rows=[],columns=[],reportTitle='Profit & Loss Statement';
  if(type==='orders') {
    reportTitle='Order Report';columns=['invoice_id','customer_name','phone','amount','status','traffic_source','created_at'];
    const data=await client.queryAll(`SELECT invoice_no AS invoice_id,customer_name,customer_phone AS phone,
      total_paisa,order_status AS status,traffic_source,created_at FROM orders ORDER BY id DESC`);
    rows=data.map((row)=>({...row,amount:amount(row.total_paisa)}));
  } else if(type==='purchases') {
    reportTitle='Purchase Report';columns=['reference_no','supplier','product','qty','unit_cost','total_cost','purchase_date'];
    const data=await client.queryAll(`SELECT pu.reference_no,s.name AS supplier,COALESCE(NULLIF(p.name_en,''),p.name_bn) AS product,
      pi.ordered_qty AS qty,pi.unit_cost_paisa,pi.line_total_paisa,pu.purchase_date FROM purchases pu
      JOIN purchase_items pi ON pi.purchase_id=pu.id LEFT JOIN suppliers s ON s.id=pu.supplier_id
      LEFT JOIN products p ON p.id=pi.product_id ORDER BY pu.id DESC,pi.id ASC`);
    rows=data.map((row)=>({...row,unit_cost:amount(row.unit_cost_paisa),total_cost:amount(row.line_total_paisa)}));
  } else if(type==='expenses') {
    reportTitle='Expense Report';columns=['id','title','category','amount','note','expense_date'];
    const data=await client.queryAll('SELECT id,title,category,amount_paisa,note,expense_date FROM expenses ORDER BY expense_date DESC,id DESC');
    rows=data.map((row)=>({...row,amount:amount(row.amount_paisa)}));
  } else if(type==='stock') {
    reportTitle='Inventory & Stock Report';columns=['code','name','category','purchase_price','new_price','stock','sold_count'];
    const data=await client.queryAll(`SELECT p.sku AS code,COALESCE(NULLIF(p.name_en,''),p.name_bn) AS name,
      COALESCE(NULLIF(c.name_en,''),c.name_bn,'') AS category,p.cost_price_paisa,p.sale_price_paisa,
      CASE WHEN p.vendor_id IS NULL THEN p.stock_on_hand ELSE p.vendor_stock_on_hand END AS stock,p.sold_count
      FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.is_archived=0 ORDER BY stock ASC,p.id ASC`);
    rows=data.map((row)=>({...row,purchase_price:amount(row.cost_price_paisa),new_price:amount(row.sale_price_paisa)}));
  } else {
    const totalSales=Number(summary.totalSales),totalExpenses=Number(summary.totalExpenses);
    rows=[
      {metric:'Total Gross Order Value (Active Orders)',amount:summary.totalSales},
      {metric:'Completed / Delivered Order Revenue',amount:summary.completedSales},
      {metric:'Total Stock Purchases Cost',amount:summary.totalPurchases},
      {metric:'Total Operational Expenses',amount:summary.totalExpenses},
      {metric:'Current Inventory Valuation (Retail)',amount:summary.stockRetailVal},
      {metric:'Net Estimated Operating Profit (Gross Orders - Expenses)',amount:(totalSales-totalExpenses).toFixed(2)},
    ];columns=['metric','amount'];
  }
  return {type,reportTitle,rows,columns,summary};
}

module.exports={listFundTransactions,getFundSummary,listExpenses,listPaymentRecords,getReport};
