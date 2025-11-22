const express = require('express')
const cors = require('cors');
require('dotenv').config()
const stripe = require('stripe')(`${process.env.PAYMENT_SECRET}`);

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express()
const port = process.env.PORT || 3000

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wfr9cox.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});
// midleware 
app.use(cors())
app.use(express.json())

app.get('/', (req, res) => {
  res.send('zap is shifting!!')
})


async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const db = client.db("Zap-Shift")
    const parcelCollection = db.collection("parcels")

    app.get('/my-parcels', async (req, res) => {
      const { email } = req.query
      const query = {}
      if (email) {
        query.senderEmail = email
      }
      const result = await parcelCollection.find(query).toArray()
      res.send(result)
    })
    app.post('/parcels', async (req, res) => {
      const newParcel = req.body
      newParcel.createdAt = new Date()
      const result = await parcelCollection.insertOne(newParcel)
      res.send(result)
    })
    app.delete('/parcel/:id', async (req, res) => {
      const { id } = req.params
      const query = { _id: new ObjectId(id) }
      const result = await parcelCollection.deleteOne(query)
      res.send(result)
    })

    // payment related apis 

    app.post('/payment-checkout-session', async (req, res) => {
      const parcelInfo=req.body
      const{email,name,productId,cost} = parcelInfo
      const amount= parseInt(cost)*100
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
           price_data:{
            currency:'USD',
            product_data:{name:name},
            unit_amount:amount
           },
            quantity: 1,
          },
        ],
        mode: 'payment',
        customer_email:email,
        metadata:{
          productId:productId
        },
        success_url: `${process.env.DOMAIN_NAME}/dashboard/payment-success`,
        cancel_url: `${process.env.DOMAIN_NAME}/dashboard/payment-cancel`,
      })
      res.send({url:session.url})
    })

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
