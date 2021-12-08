hexo clean&&hexo deploy
git add .
curr_date_time="`date +%Y-%m-%d,%H:%m:%s`"  
git commit -m "auto commit $curr_date_time"
git push
