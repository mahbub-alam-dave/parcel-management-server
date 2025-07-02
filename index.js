const express = require("express");
const cors = require("cors");
require("dotenv").config();
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("backend server integrated");
});

const uri = `mongodb+srv://${process.env.PROFAST_USER}:${process.env.PROFAST_PASS}@mydatabase.sr7puaa.mongodb.net/?retryWrites=true&w=majority&appName=MyDatabase`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

var admin = require("firebase-admin");

var serviceAccount = require("./firebase-admin-sdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    const parcelCollection = client.db("ProFastDB").collection("parcels");
    const paymentCollection = client.db("ProFastDB").collection("payments");
    const usersCollections = client.db("ProFastDB").collection("users")
    const ridersCollections = client.db("ProFastDB").collection("riders")

    // custom middleware
    const verifyFirebaseToken = async (req, res, next) => {
      const accessToken = req?.headers?.authorization
      // console.log("token", accessToken)

      if(!accessToken) {
        res.status(400).send({message: "Unauthorized access"})
      }

      const token = accessToken.split(' ')[1]
      if(!token){
        res.status(400).send({message: "Unauthorized access"})
      }

      // verify token
      try {
        const decoded = await admin.auth().verifyIdToken(token)
        req.decoded = decoded
        next()
      }
      catch(error) {
        res.status(403).send({message: "forbidden"})
      }
    }

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = {userEmail: email}
      const user = await usersCollections.findOne(query)
      if(!user || user.role !== "admin") {
        return res.status(403).send({message: "Forbidden Access"})
      }

      next()
    }

    // store users info
    app.post("/users", async (req, res) => {
      const email = req.body.userEmail;
      const existUsers = await usersCollections.findOne({userEmail: email})

      if(existUsers) {
        const lastLoggedIn = req.body.lastLoggedIn;
        const update = await usersCollections.updateOne({userEmail: email}, {$set:{lastLoggedIn: lastLoggedIn}})
        return res.status(200).send({message: "Users already exists", inserted: false})
      }
      const user = req.body;
      const result = await usersCollections.insertOne(user)
      res.send(result)

    })


    // get my parcels by email query
    app.get("/parcels", verifyFirebaseToken, async (req, res) => {
      const userEmail = req.query.email;

        // console.log('req headers', req.headers)

      try {

        if (!userEmail) {
          return res
            .status(400)
            .send({ message: "Email query parameter is required" });
        }

        // const query = userEmail ? { email: userEmail } : {};
        const query =  { email: userEmail }
        const options = {
          sort: { creationDate: -1 },
        };

        const parcels = await parcelCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels", error);
        res.status(500).send({ message: "failed to get parcels" });
      }
    });

    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;

        const result = await parcelCollection.insertOne(newParcel);
        res.status(201).send(result);
      } catch (error) {
        console.error("error inserting parcel:", error);
        res.status(500).send({ message: "failed to create parcel" });
      }
    });

    
    app.delete("/parcels/:id", async (req, res) => {
      const { id } = req.params;

      try {
        const deletedParcel = await parcelCollection.deleteOne({_id: new ObjectId(id)});

        if(deletedParcel.deletedCount) {
          res.send(deletedParcel)
        }

      } catch (error) {
        console.error("Error deleting parcel:", error.message);
        res.status(500).json({
          success: false,
          message: "Server error while deleting parcel.",
        });
      }
    });


    app.get('/parcels/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const parcel = await parcelCollection.findOne({ _id: new ObjectId(id) });

    if (!parcel) {
      return res.status(404).json({ message: 'Parcel not found' });
    }

    res.status(200).json(parcel);

  } catch (error) {
    res.status(500).json({ message: 'Error fetching parcel', error: error.message });
  }
});

// image upload 
// app.post('/')


// payment method 
app.post('/create-payment-intent', async (req, res) => {
  const amountInCents = req.body.amountInCents;
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents, // Amount in cents
      currency: 'usd',
      payment_method_types: ['card']
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// payment history and payment status
app.post('/payments', async (req, res) => {
  const { userEmail, parcelId, amount, transactionId, date } = req.body;

  try {

    const updateStatus = await parcelCollection.updateOne(
      {_id: new ObjectId(parcelId)}, {$set: { paymentStatus: "paid" }})

      if(updateStatus.modifiedCount === 0) {
        return res.status(404).send({message: 'parcel not found'})
      }

    const result = await paymentCollection.insertOne({
      userEmail,
      parcelId,
      amount,
      transactionId,
      paid_at_string: new Date().toISOString(),
      date: date || new Date(),
    });

    res.status(201).json({ message: 'Payment record saved', paymentId: result.insertedId });

  } catch (error) {
    res.status(500).json({ message: 'Error saving payment record', error: error.message });
  }
});

// GET /api/payments/user/:email
app.get('/payments', verifyFirebaseToken, async(req, res) => {

  const email = req.query.email;
  if(req.decoded.email !== email) {
    res.status(403).send({message: "Forbidden Access"})
  }
  
  // console.log('received query email', )
  try {
    const query = { userEmail: email}
    const options = {sort: {paid_at_string: -1}}

    const payments = await paymentCollection.find(query, options).toArray();

    res.status(200).json(payments);

  } catch (error) {
    res.status(500).json({ message: 'Error fetching payments', error: error.message });
  }
});

// tracking
app.get('/tracking', async(req, res) => {
  const {tracking_id, parcel_id, paymentStatus, deliverStatus, message, updated_by='' } = req.body;

  const trackingParcel = {
    tracking_id,
    parcel_id: parcel_id ? new ObjectId(parcel_id) : undefined,
    paymentStatus,
    deliverStatus,
    message,
    time: new Date(),
    updated_by
  }
  const result = await trackingCollection.insertOne(trackingParcel)
  res.send(result)
})

// add riders to database
app.post('/riders', async (req, res) => {
  const rider = req.body;
  const result = await ridersCollections.insertOne(rider)
  res.send(result)
})

// GET riders with status 'pending'
app.get("/pending-riders", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const pendingRiders = await ridersCollections.find({ status: "pending" }).toArray();
    res.status(200).json(pendingRiders);
  } catch (error) {
    console.error("Failed to fetch pending riders", error);
    res.status(500).json({ message: "Server error fetching pending riders" });
  }
});

app.get('/active-riders', verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const pendingRiders = await ridersCollections.find({ status: "approved" }).toArray();
    res.status(200).json(pendingRiders);
  } catch (error) {
    console.error("Failed to fetch active riders", error);
    res.status(500).json({ message: "Server error fetching active riders" });
  }
})

app.patch('/riders/:id/newStatus', async(req, res) => {
  const {id} =  req.params;
  const {status, email} = req.body;
  try {
    const result = await ridersCollections.updateOne({_id: new ObjectId(id)}, {$set:{status}})
  res.send(result)

  if(status === "approved"){
    const query = {userEmail: email}
    const updatedDoc = {
      $set: {
        role: "rider"
      }
    }
    const result = await usersCollections.updateOne(query, updatedDoc)
  }
  }
  catch(error) {
    res.status(500).send({message: "failed to update rider status"})
  }
})


// admin set role by searching users
app.get("/users/search", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).send({ message: "Query required" });

  const result = await usersCollections.find({
    $or: [
      { userEmail: { $regex: query, $options: "i" } },
      { userName: { $regex: query, $options: "i" } }
    ]
  }).limit(10).toArray();

  if (!result) {
    return res.status(404).send({ message: "User not found" });
  }

  res.send(result);
});

app.patch("/users/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!role) {
    return res.status(400).send({ message: "Role value is required" });
  }

  try {
    const result = await usersCollections.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role } }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).send({ message: "User not found or role unchanged" });
    }

    res.send({ message: "User role updated successfully", result });
  } catch (error) {
    console.error("Failed to update user role", error);
    res.status(500).send({ message: "Failed to update user role" });
  }
});

// check user role
app.get("/users/role", async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).send({ message: "Email query parameter is required" });
  }

  try {
    const user = await usersCollections.findOne({ userEmail: email });

    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }

    res.send({ role: user.role || "user" });
  } catch (error) {
    console.error("Failed to fetch user role", error);
    res.status(500).send({ message: "Failed to fetch user role" });
  }
});



    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(` app is listening on port ${port}`);
});
