'use strict';

process.env.LOG_SILENT = 'true';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const finance = require('../src/repositories/adminFinanceReadRepository');

function poolFor(responses) {
  const calls=[];
  return { calls, async query(sql,params=[]) {
    calls.push({sql,params});
    const key=Object.keys(responses).sort((a,b)=>b.length-a.length).find((candidate)=>sql.includes(candidate));
    if(!key)throw new Error(`Unexpected SQL: ${sql}`);
    return [responses[key],[]];
  }};
}

test('finance payment listing is read-only, parameterized, filterable and converts integer paisa',async()=>{
  const pool=poolFor({'FROM order_payments op JOIN orders o':[{
    id:8,order_id:3,invoice_no:'INV-3',customer_name:'A Customer',customer_phone:'01712345678',
    gateway_code:'bkash',provider_trx_id:'TRX-8',sender_number:'01812345678',amount_paisa:12550,
    payment_purpose:'advance',status:'pending',created_at:'2026-10-01 10:00:00'
  }]});
  const rows=await finance.listPaymentRecords({status:'pending',search:'TRX-8'}, {pool});
  assert.equal(rows.length,1);
  assert.equal(rows[0].amount,'125.50');
  assert.equal(rows[0].invoice_no,'INV-3');
  assert.match(pool.calls[0].sql,/JOIN orders o/);
  assert.match(pool.calls[0].sql,/op\.status=\?/);
  assert.deepEqual(pool.calls[0].params,['pending','%TRX-8%','%TRX-8%','%TRX-8%','%TRX-8%',250]);
  assert.doesNotMatch(pool.calls[0].sql,/INSERT|UPDATE|DELETE/i);
});

test('MySQL finance reports use canonical paisa/order fields and preserve the report projections',async()=>{
  const pool=poolFor({
    'ORDER BY id DESC':[ {invoice_id:'INV-1',customer_name:'Customer',phone:'01712345678',total_paisa:4200,status:'completed',traffic_source:'Direct',created_at:'2026-10-01'} ],
    'ORDER BY expense_date DESC':[ {id:2,title:'Packaging',category:'Operations',amount_paisa:1250,note:'boxes',expense_date:'2026-10-02'} ],
    'JOIN purchase_items pi':[ {reference_no:'PO-1',supplier:'Orchard',product:'Mango',qty:2,unit_cost_paisa:500,line_total_paisa:1000,purchase_date:'2026-10-03'} ],
    'FROM products p LEFT JOIN categories c':[ {code:'SKU-1',name:'Mango',category:'Fruit',cost_price_paisa:500,sale_price_paisa:800,stock:4,sold_count:1} ],
    'AS total_sales_paisa':[ {total_sales_paisa:4200,completed_sales_paisa:4200} ],
    'AS total_purchases_paisa':[ {total_purchases_paisa:1000} ],
    'AS total_expenses_paisa':[ {total_expenses_paisa:1250} ],
    'AS stock_cost_paisa':[ {stock_cost_paisa:2000,stock_retail_paisa:3200} ],
  });
  const orders=await finance.getReport('orders',{pool});
  assert.equal(orders.rows[0].amount,'42.00');
  const expenses=await finance.getReport('expenses',{pool});
  assert.equal(expenses.rows[0].amount,'12.50');
  const purchases=await finance.getReport('purchases',{pool});
  assert.equal(purchases.rows[0].total_cost,'10.00');
  const stock=await finance.getReport('stock',{pool});
  assert.equal(stock.rows[0].purchase_price,'5.00');
  const pnl=await finance.getReport('profitloss',{pool});
  assert.ok(pnl.summary.totalSales);
  assert.ok(pool.calls.every((call)=>Array.isArray(call.params)));
  assert.ok(pool.calls.some(({sql})=>sql.includes('total_paisa')));
  assert.ok(pool.calls.some(({sql})=>sql.includes('amount_paisa')));
  assert.ok(pool.calls.every(({sql})=>!/(INSERT|UPDATE|DELETE)\s/i.test(sql)));
  await assert.rejects(finance.getReport('../unsafe',{pool}),{code:'VALIDATION_ERROR'});
});
