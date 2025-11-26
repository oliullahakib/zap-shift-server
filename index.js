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

// traking id generator 
function createTrackingId() {
  const prefix = 'BDX-';
  const timestampPart = Date.now().toString(36).toUpperCase();
  const randomPart = Math.random().toString(16).substring(2, 8).toUpperCase();
  return `${prefix}${timestampPart}-${randomPart}`;
}

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const db = client.db("Zap-Shift")
    const parcelCollection = db.collection("parcels")
    const paymentCollection = db.collection("payment")
    const usersCollection = db.collection("users")
    const riderCollection = db.collection("rider")

    // user releted apis 
    app.post('/user', async (req, res) => {
      const newUser = req.body
      newUser.createdAt = new Date()
      newUser.role = "user"
      const result = await usersCollection.insertOne(newUser)
      res.send(result)
    })

    // parcel releted apis 
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
      const parcelInfo = req.body
      const { email, name, parcelId, cost } = parcelInfo
      const amount = parseInt(cost) * 100
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'USD',
              product_data: { name: name },
              unit_amount: amount
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        customer_email: email,
        metadata: {
          parcelId: parcelId
        },
        success_url: `${process.env.DOMAIN_NAME}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.DOMAIN_NAME}/dashboard/payment-cancel`,
      })
      res.send({ url: session.url })
    })

    app.patch('/payment', async (req, res) => {
      const { session_id } = req.query
      const sessonData = await stripe.checkout.sessions.retrieve(session_id)
      const trakingId = createTrackingId()
      // modify the parcel 
      const id = sessonData.metadata.parcelId
      const filter = { id: new ObjectId(id) }
      const update = {
        $set: {
          paymentStatus: sessonData.payment_status,
          trakingId
        }
      }
      const modifyResult = parcelCollection.updateOne(filter, update)

      // creat a transaciton history 
      const paymentInfo = {
        amoun: sessonData.amount_total,
        currency: sessonData.currency,
        payer_email: sessonData.customer_email,
        productId: sessonData.metadata.parcelId,
        transactionId: sessonData.payment_intent,
        paymentStatus: sessonData.payment_status,
        payAt: new Date()

      }
      const query = { transactionId: paymentInfo.transactionId }
      const parcelExsit = await paymentCollection.findOne(query)

      if (parcelExsit) {
        return res.send({
          message: "Payment already complite for this parcel",
          transactionId: sessonData.payment_intent,
          trakingId,
        })
      }
      const paymentResult = paymentCollection.insertOne(paymentInfo)

      res.send({
        message: "True",
        paymentResult,
        transactionId: sessonData.payment_intent,
        trakingId,
        modifyResult
      })
    })

    // rider related apis 
    app.get('/riders',async(req,res)=>{
      const result = await riderCollection.find().sort({createdAt:-1}).toArray()
      res.send(result)
    })
    app.post('/rider', async (req, res) => {
      const newRider = req.body
      newRider.createdAt = new Date()
      newRider.status = "pending"
      if(!newRider.email){
        return res.send({message:"Email is requerd to apply"})
      }
      // checking the application 
      console.log(newRider.email)
      const query = {}
      if (newRider.email) {
        query.email = newRider.email
      }
      const riderExist = riderCollection.findOne(query)
      if (riderExist) {
        return res.send({ message: "Your Application already taken.Please wait for approval" })
      }
      const result = await riderCollection.insertOne(newRider)
      res.send(result)
    })
   
     app.delete('/rider/:id', async (req, res) => {
      const { id } = req.params
      const query = { _id: new ObjectId(id) }
      const result = await riderCollection.deleteOne(query)
      res.send(result)
    })
     app.patch('/rider/:id',async(req,res)=>{
       const { id } = req.params
       console.log(req.body)
       const {status,email} = req.body
      const query = { _id: new ObjectId(id) }
      const update = {
        $set:{status}
      }
      const result = await riderCollection.updateOne(query,update)

      if(status==="accepted"){
        const query={}
        if(email){
          query.email=email
        }
        const updateRole = {
          $set:{role:"rider"}
        }
        const userResult = usersCollection.updateOne(query,updateRole)
      }
      res.send(result)
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
