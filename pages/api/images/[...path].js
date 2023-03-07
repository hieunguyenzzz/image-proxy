import fs from 'fs'
import path from 'path'
import axios from 'axios';

export default async function handler(req, res) {
  const { path: imageFile } = req.query;
  const name = imageFile[imageFile.length - 1];
  const filePath = path.resolve('.', 'public/images/', ...imageFile);

 let url = 'https://res.cloudinary.com/' + imageFile.join('/');
 
  if (!fs.existsSync(filePath)) {
    console.log('downloading');
    await downloadImage(url, filePath);
  }

  const imageBuffer = fs.readFileSync(filePath)

  res.setHeader('Content-Type', 'image/' + name.substring(name.length - 3))
  res.send(imageBuffer)
}

const downloadImage = async (url, filePath) => {
  const response = await axios({
    url,
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
