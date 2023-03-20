import fs from 'fs'
import path from 'path'
import axios from 'axios';
import url from 'url';

export default async function handler(req, res) {
  const { path: imageFile } = req.query;
  const name = imageFile[imageFile.length - 1];
  const filePath = path.resolve('.', 'public/images/', ...imageFile);

 let imageUrl = 'https://res.cloudinary.com/' + imageFile.join('/');
 
  if (!fs.existsSync(filePath)) {
    console.log('downloading ' + imageUrl);
    try {
      await downloadImage(imageUrl, filePath);
    } catch (error) {
      const parts = imageUrl.split("media/catalog/product");
      const filename = parts[1];
      if (typeof filename != "undefined")  {
        let actualFile = 'https://static.mobelaris.com/media/catalog/product' + filename;
        const imageResponse = await axios.get(actualFile, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(imageResponse.data, 'binary');

        // Set the appropriate content-type for the image file
        res.setHeader('Content-Type', 'image/jpeg');

        // Send the image file as response
        res.send(imageBuffer);
        return;
      }

    }

    
    
  }

  
  const imageBuffer = fs.readFileSync(filePath)

  res.setHeader('Content-Type', 'image/' + name.substring(name.length - 3))
  res.send(imageBuffer)

}

const downloadImage = async (imageUrl, filePath) => {
  const response = await axios({
    imageUrl,
    responseType: 'stream',
  });

  const directoryPath = path.dirname(filePath);
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const stream = response.data.pipe(fs.createWriteStream(filePath));
    stream.on('finish', () => resolve());
    stream.on('error', e => reject(e));
  });
};
