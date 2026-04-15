import { BigQuery } from '@google-cloud/bigquery';

const bigquery = new BigQuery({
  projectId: process.env.BIGQUERY_PROJECT_ID || 'yhangry',
  keyFilename: process.env.BIGQUERY_KEYFILE_PATH || './credentials/bigquery.json',
});

const p = process.env.BIGQUERY_PROJECT_ID || 'yhangry';
const d = process.env.BIGQUERY_DATASET || 'yhangry_booking';
const t = (table) => `\`${p}.${d}.${table}\``;

export async function getBookingByPaymentId(paymentId) {
  const query = `
    SELECT
      o.id                        AS order_id,
      o.meal_date                 AS event_date,
      o.payment_id                AS stripe_payment_id,
      o.number_of_guests,
      o.payable_amount            AS total_amount,
      o.order_status,

      -- Customer details (via customers table)
      cust.id                     AS customer_id,
      cust.phone                  AS customer_phone,

      -- Customer name + email (via users polymorphic)
      cu.first_name,
      cu.last_name,
      cu.email                    AS customer_email,

      -- Chef details
      ch.id                       AS chef_id,
      ch.flakes_count,
      ch.phone                    AS chef_phone,

      -- Chef name + email (via users polymorphic)
      chef_u.first_name           AS chef_first_name,
      chef_u.last_name            AS chef_last_name,
      chef_u.email                AS chef_email,

      -- Chef attendance (from chef_job)
      cj.is_chef_ready_response,
      cj.is_chef_on_time_response,
      cj.status                   AS chef_job_status,

      -- Event address
      a.house_number_name         AS address_line1,
      a.street_name               AS address_line2,
      a.postcode                  AS address_postcode,

      -- Chef post-booking survey (proof of attendance)
      CASE WHEN cf.id IS NOT NULL THEN true ELSE false END AS chef_submitted_payment_survey,
      cf.grocery_cost             AS survey_grocery_cost,
      cf.chef_comment             AS survey_chef_comment,
      cf.customer_rating          AS survey_customer_rating

    FROM ${t('orders')} o

    -- Customer
    JOIN ${t('customers')} cust ON cust.id = o.customer_id
    JOIN ${t('users')} cu
      ON cu.userable_id = cust.id
      AND cu.userable_type LIKE '%Customer%'

    -- Chef (via jobs → chef_job → chefs)
    JOIN ${t('jobs')} j ON j.order_id = o.id
    JOIN ${t('chef_job')} cj ON cj.job_id = j.id
    JOIN ${t('chefs')} ch ON ch.id = cj.chef_id
    JOIN ${t('users')} chef_u
      ON chef_u.userable_id = ch.id
      AND chef_u.userable_type LIKE '%Chef%'

    -- Address
    JOIN ${t('address_order')} ao ON ao.order_id = o.id
    JOIN ${t('addresses')} a ON a.id = ao.address_id

    -- Chef post-booking payment survey (LEFT JOIN — may not exist)
    LEFT JOIN ${t('chef_feedback')} cf ON cf.order_id = o.id AND cf.chef_id = ch.id

    WHERE o.payment_id = @paymentId
    LIMIT 1
  `;

  const [rows] = await bigquery.query({
    query,
    params: { paymentId },
  });
  return rows[0] || null;
}

export async function getPlatformMessages(orderId) {
  const query = `
    SELECT
      m.id,
      m.body,
      m.created_at,
      m.type,
      m.customer_id,
      m.chef_id,
      cu.first_name   AS customer_first_name,
      chef_u.first_name AS chef_first_name,
      CASE
        WHEN m.type = 'customer' THEN 'customer'
        WHEN m.type = 'chef' THEN 'chef'
        WHEN m.type LIKE 'admin%' THEN 'admin'
        ELSE m.type
      END AS sender_role
    FROM ${t('messages')} m
    LEFT JOIN ${t('customers')} cust ON cust.id = m.customer_id
    LEFT JOIN ${t('users')} cu
      ON cu.userable_id = cust.id
      AND cu.userable_type LIKE '%Customer%'
    LEFT JOIN ${t('chefs')} ch ON ch.id = m.chef_id
    LEFT JOIN ${t('users')} chef_u
      ON chef_u.userable_id = ch.id
      AND chef_u.userable_type LIKE '%Chef%'
    WHERE m.order_id = @orderId
    ORDER BY m.created_at ASC
  `;

  const [rows] = await bigquery.query({ query, params: { orderId } });
  return rows;
}
